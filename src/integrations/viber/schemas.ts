import { z } from 'zod';

const viberUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  avatar: z.string().url().optional(),
  country: z.string().length(2).optional(),
  language: z.string().length(2).optional(),
  api_version: z.number().int().positive().optional(),
  viber_version: z.string().optional(),
  mcc: z.string().optional(),
  mnc: z.string().optional(),
  device_type: z.string().optional(),
});

const callbackBaseSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  message_token: z.string().min(1).optional(),
});

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

const contactSchema = z.object({
  name: z.string().min(1).max(128),
  phone_number: z.string().min(1).max(18),
  avatar: z.string().url().optional(),
});

const textMessageSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  tracking_data: z.string().optional(),
});

const pictureMessageSchema = z.object({
  type: z.literal('picture'),
  text: z.string(),
  media: z.string().url(),
  thumbnail: z.string().url().optional(),
  tracking_data: z.string().optional(),
});

const videoMessageSchema = z.object({
  type: z.literal('video'),
  media: z.string().url(),
  thumbnail: z.string().url().optional(),
  size: z.number().int().nonnegative(),
  duration: z.number().int().nonnegative().optional(),
  tracking_data: z.string().optional(),
});

const fileMessageSchema = z.object({
  type: z.literal('file'),
  media: z.string().url(),
  file_name: z.string().min(1).max(256),
  file_size: z.number().int().nonnegative(),
  tracking_data: z.string().optional(),
});

const contactMessageSchema = z.object({
  type: z.literal('contact'),
  contact: contactSchema,
  tracking_data: z.string().optional(),
});

const locationMessageSchema = z.object({
  type: z.literal('location'),
  location: locationSchema,
  tracking_data: z.string().optional(),
});

const stickerMessageSchema = z.object({
  type: z.literal('sticker'),
  sticker_id: z.number().int().nonnegative(),
  tracking_data: z.string().optional(),
});

const urlMessageSchema = z.object({
  type: z.literal('url'),
  media: z.string().url(),
  tracking_data: z.string().optional(),
});

export const viberMessageSchema = z.discriminatedUnion('type', [
  textMessageSchema,
  pictureMessageSchema,
  videoMessageSchema,
  fileMessageSchema,
  stickerMessageSchema,
  contactMessageSchema,
  locationMessageSchema,
  urlMessageSchema,
]);

const webhookCallbackSchema = callbackBaseSchema.extend({
  event: z.literal('webhook'),
  message_token: z.string().min(1),
});

const deliveredCallbackSchema = callbackBaseSchema.extend({
  event: z.literal('delivered'),
  message_token: z.string().min(1),
  user_id: z.string().min(1),
});

const seenCallbackSchema = callbackBaseSchema.extend({
  event: z.literal('seen'),
  message_token: z.string().min(1),
  user_id: z.string().min(1),
});

const failedCallbackSchema = callbackBaseSchema.extend({
  event: z.literal('failed'),
  message_token: z.string().min(1),
  user_id: z.string().min(1),
  desc: z.string(),
});

const subscribedCallbackSchema = callbackBaseSchema.extend({
  event: z.literal('subscribed'),
  message_token: z.string().min(1),
  user: viberUserSchema,
});

const unsubscribedCallbackSchema = callbackBaseSchema.extend({
  event: z.literal('unsubscribed'),
  message_token: z.string().min(1),
  user_id: z.string().min(1),
});

const conversationStartedCallbackSchema = callbackBaseSchema.extend({
  event: z.literal('conversation_started'),
  message_token: z.string().min(1),
  type: z.literal('open'),
  context: z.string().optional(),
  user: viberUserSchema,
  subscribed: z.boolean(),
});

const messageCallbackSchema = callbackBaseSchema.extend({
  event: z.literal('message'),
  message_token: z.string().min(1),
  sender: viberUserSchema,
  message: viberMessageSchema,
});

export const viberCallbackSchema = z.discriminatedUnion('event', [
  webhookCallbackSchema,
  deliveredCallbackSchema,
  seenCallbackSchema,
  failedCallbackSchema,
  subscribedCallbackSchema,
  unsubscribedCallbackSchema,
  conversationStartedCallbackSchema,
  messageCallbackSchema,
]);

export type ViberUser = z.infer<typeof viberUserSchema>;
export type ViberMessage = z.infer<typeof viberMessageSchema>;
export type ViberCallback = z.infer<typeof viberCallbackSchema>;
