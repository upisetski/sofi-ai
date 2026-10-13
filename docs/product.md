# Product Context

## Product

**Sofi — AI assistant for Viber**

Sofi is a free AI assistant available in Viber, initially targeted at Belarusian users.

The core product hypothesis is that Viber is a convenient place to access AI for people who may not use dedicated AI products directly.

The first external MVP scope and implementation order are defined in the [MVP roadmap](roadmap.md).

## Core interaction

> **Send it to Sofi. We'll figure it out.**

Users should be able to send text messages without learning commands. The first external MVP includes bounded multi-turn conversations and web search when current information is required. Image input is deferred until after this MVP.

## Product capabilities

### Write

- write a message
- write a greeting
- write an email
- formulate a reply

### Rewrite

- make it shorter
- make it warmer
- make it less formal
- make it clearer

### Explain

- explain a concept simply
- explain a message
- summarize something
- clarify what a text means

### Ideas

- gift ideas
- names
- plans
- alternatives
- suggestions

### Vision (future capability; not in the first MVP)

- read text from a photo
- understand a screenshot
- explain what is shown
- read an instruction or announcement

### Web

Use web search when the user needs current information such as current prices, news, rules, opening hours, or other time-sensitive facts.

Do not use web search when current information is unnecessary.

## Inputs at first external launch

Supported:
- text

Deferred until after the first MVP:
- images
- audio
- video
- documents

## Audience hypothesis

Primary audience hypothesis:
- Belarusian Viber users
- strong potential in adults 30+
- likely emphasis on practical everyday assistance rather than developer-focused AI use

This is a hypothesis, not a validated market conclusion.

## Personality

Sofi should be:
- warm
- competent
- concise
- approachable
- helpful
- clearly an AI assistant

She should not:
- pretend to be a real person
- overuse emojis
- be overly cute
- be robotic
- sound corporate or bureaucratic

A useful framing is:

> Скидывай. Разберёмся 🙂

## Current product uncertainty

We do not yet know which use case will dominate.

Initial intent buckets:
- write
- rewrite
- explain
- ideas
- web
- other

Analytics should be used to discover the real distribution rather than assuming one segment is the winner.

## Key early metrics

- first message rate
- messages per user
- sessions per user
- returning users
- D1 / D7 / D30 retention
- intent distribution
- web-search usage
- AI cost per active user
- follow-up rate
- error rate
- response latency

A particularly useful quality signal is a follow-up instruction after an answer, such as “make it shorter” or “make it warmer”.

## Cost model

Sofi is free to users.

Required safety limits before the first external user rollout include:
- per-user daily USD budget
- daily text-request and web-search limits
- per-request maximum cost
- global daily/monthly budget
- economy mode near the global budget ceiling

These controls are implemented for the current `cheap_text` route: the application reserves estimated costs before provider calls, reconciles reported or estimated usage, and enforces per-user request/daily-budget limits, a per-request cost guard, and global daily/monthly ceilings. The default per-user daily spend allowance is $1.00 for the current development/testing phase; the separate $2 global daily and $30 global monthly ceilings, 50 requests per user/day, and $0.01 per-request estimate guard remain in force. Web search and any separately billed search costs must pass through the same guard before that route is enabled. See the [MVP roadmap](roadmap.md) for the release gate. Exact thresholds should be configurable and adjusted using real usage data.
