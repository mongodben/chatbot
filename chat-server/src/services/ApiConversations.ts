import { ObjectId, References } from "chat-core";
import {
  CreateConversationParams,
  FindByIdParams,
  RateMessageParams,
  SomeMessage,
} from "./conversations";
import { OpenAiMessageRole } from "./ChatLlm";

/**
  Conversation between the user and the API chatbot.
 */
export interface ApiConversation {
  _id: ObjectId;
  /** Messages in the conversation. */
  messages: SomeMessage[];
  /** The IP address of the user performing the conversation. */
  ipAddress: string;
  /** The date the conversation was created. */
  createdAt: Date;
}

// TODO: expand
interface AddApiConversationMessageParams<T> {
  conversationId: ObjectId;
  content: string;
  preprocessedContent?: string;
  role: OpenAiMessageRole;
  references?: References;
  /**
    Api-specifc credentials for the chatbot to use when interacting with the API.
   */
  credentials: T;
  /**
    The vector representation of the message content.
     */
  embedding?: number[];

  rejectQuery?: boolean;
}

export interface ConversationsService<T> {
  create: ({ ipAddress }: CreateConversationParams) => Promise<ApiConversation>;
  addConversationMessage: (
    params: AddApiConversationMessageParams<T>
  ) => Promise<SomeMessage>;
  findById: ({ _id }: FindByIdParams) => Promise<ApiConversation | null>;
  rateMessage: ({
    conversationId,
    messageId,
    rating,
  }: RateMessageParams) => Promise<boolean>;
}
