import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const sqs = new SQSClient({});
const sns = new SNSClient({});

export const send = () => sqs.send(new SendMessageCommand({
  QueueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/email-outbox",
  MessageBody: "x",
}));

export const drain = () => sqs.send(new ReceiveMessageCommand({
  QueueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/email-outbox",
}));

export const fanout = () => sns.send(new PublishCommand({
  TopicArn: "arn:aws:sns:eu-west-1:123456789012:driver-alerts",
  Message: "x",
}));
