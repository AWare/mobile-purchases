import {HTTPRequest, HTTPResponse, HTTPResponses} from "../models/apiGatewayHttp";
import {SubscriptionEvent} from "../models/subscriptionEvent";
import DynamoDB from 'aws-sdk/clients/dynamodb';
import Sqs from 'aws-sdk/clients/sqs';
import {CredentialProviderChain, SharedIniFileCredentials, ECSCredentials, AWSError} from "aws-sdk";
import {DataMapper} from '@aws/dynamodb-data-mapper';
import {Region} from "../utils/appIdentity";
import {PromiseResult} from "aws-sdk/lib/request";

export const ONE_YEAR_IN_SECONDS = 31557600;

const credentialProvider = new CredentialProviderChain([
    function () { return new ECSCredentials(); },
    function () { return new SharedIniFileCredentials({
        profile: "mobile"
    }); }
]);

const dynamo = new DynamoDB({
    region: Region,
    credentialProvider: credentialProvider
});

const sqs = new Sqs({
    region: Region,
    credentialProvider: credentialProvider
});

const dynamoMapper = new DataMapper({ client: dynamo });

async function catchingServerErrors(block: () => Promise<HTTPResponse>): Promise<HTTPResponse> {
    try {
        return block();
    } catch (e) {
        console.error("Internal server error", e);
        return HTTPResponses.INTERNAL_ERROR
    }
}

function storeInDynamoImpl(event: SubscriptionEvent): Promise<SubscriptionEvent> {
    return dynamoMapper.put({item: event}).then(result => result.item);
}

function sendToSqsImpl(event: any): Promise<PromiseResult<Sqs.SendMessageResult, AWSError>> {
    const queueUrl = process.env.QueueUrl;
    if (queueUrl === undefined) throw new Error("No QueueUrl env parameter provided");
    return sqs.sendMessage({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(event)
    }).promise()
}

export async function parseStoreAndSend<Payload, SqsEvent>(
    request: HTTPRequest,
    parsePayload: (body?: string) => Payload | Error,
    toDynamoEvent: (payload: Payload) => SubscriptionEvent,
    toSqsEvent: (payload: Payload) => SqsEvent,
    storeInDynamo: (event: SubscriptionEvent) => Promise<SubscriptionEvent> = storeInDynamoImpl,
    sendToSqs: (event: SqsEvent) => Promise<PromiseResult<Sqs.SendMessageResult, AWSError>> = sendToSqsImpl,
): Promise<HTTPResponse> {
    const secret = process.env.Secret;
    return catchingServerErrors(async () => {
        if (request.queryStringParameters && request.queryStringParameters.secret === secret) {
            const notification = parsePayload(request.body);
            if (notification instanceof Error) {
                return HTTPResponses.INVALID_REQUEST
            }

            const dynamoEvent = toDynamoEvent(notification);
            const dynamoPromise = storeInDynamo(dynamoEvent);

            const sqsEvent = toSqsEvent(notification);
            const sqsPromise = sendToSqs(sqsEvent);

            return Promise.all([sqsPromise, dynamoPromise])
                .then(value => HTTPResponses.OK)
                .catch(error => {
                    console.error("Unable to process event" + notification, error);
                    return HTTPResponses.INTERNAL_ERROR
                });

        } else {
            return HTTPResponses.UNAUTHORISED
        }
    });
}



