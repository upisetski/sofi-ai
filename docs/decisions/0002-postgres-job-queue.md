# ADR 0002: PostgreSQL-backed job queue

## Status

Accepted

## Decision

Use PostgreSQL as the durable queue for asynchronous message processing in the MVP.

## Context

Viber webhooks should return quickly. AI processing may take several seconds, so messages need asynchronous processing.

## Why

A PostgreSQL-backed queue gives us durable jobs, retries, visibility into failed work, no additional infrastructure, and one data system at MVP scale.

## Alternative

Redis + BullMQ is a future option. Move to it only when queue throughput, worker concurrency, or operational requirements make PostgreSQL insufficient.
