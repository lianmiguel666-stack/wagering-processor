#!/bin/bash
# Creates the queues on LocalStack start-up. The application also creates them
# idempotently (SQS_AUTO_CREATE_QUEUES=true), with the same attributes.
set -euo pipefail

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600 >/dev/null

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# maxReceiveCount = SQS_MAX_RECEIVE_COUNT (5) + 1: the consumer dead-letters
# explicitly at 5; the redrive policy is only a safety net for crash loops.
awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":6}\"}" >/dev/null

awslocal sqs create-queue --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null

echo "queues ready"
