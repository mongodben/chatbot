import {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
} from "express";
import {
  OpenAiChatMessage,
  ObjectId,
  OpenAiMessageRole,
  EmbedFunc,
  EmbeddedContent,
  EmbeddedContentStore,
  FindNearestNeighborsOptions,
  References,
  Reference,
  WithScore,
} from "chat-core";
import {
  Conversation,
  ConversationsService,
  Message,
  conversationConstants,
} from "../../services/conversations";
import { DataStreamer } from "../../services/dataStreamer";
import {
  Llm,
  OpenAiAwaitedResponse,
  OpenAiStreamingResponse,
} from "../../services/llm";
import {
  ApiConversation,
  ApiMessage,
  areEquivalentIpAddresses,
  convertMessageFromDbToApi,
  isValidIp,
} from "./utils";
import { getRequestId, logRequest, sendErrorResponse } from "../../utils";
import { z } from "zod";
import { SomeExpressRequest } from "../../middleware/validateRequestSchema";
import { SearchBooster } from "../../processors/SearchBooster";
import { QueryPreprocessorFunc } from "../../processors/QueryPreprocessorFunc";
import { stripIndent } from "common-tags";

export const MAX_INPUT_LENGTH = 300; // magic number for max input size for LLM
export const MAX_MESSAGES_IN_CONVERSATION = 13; // magic number for max messages in a conversation

export type AddMessageRequestBody = z.infer<typeof AddMessageRequestBody>;
export const AddMessageRequestBody = z.object({
  message: z.string(),
});

export type AddMessageRequest = z.infer<typeof AddMessageRequest>;
export const AddMessageRequest = SomeExpressRequest.merge(
  z.object({
    headers: z.object({
      "req-id": z.string(),
    }),
    params: z.object({
      conversationId: z.string(),
    }),
    query: z.object({
      stream: z.string().optional(),
    }),
    body: AddMessageRequestBody,
    ip: z.string(),
  })
);

export interface AddMessageToConversationRouteParams {
  store: EmbeddedContentStore;
  conversations: ConversationsService;
  embed: EmbedFunc;
  llm: Llm<OpenAiStreamingResponse, OpenAiAwaitedResponse>;
  dataStreamer: DataStreamer;
  findNearestNeighborsOptions?: Partial<FindNearestNeighborsOptions>;
  searchBoosters?: SearchBooster[];
  userQueryPreprocessor?: QueryPreprocessorFunc;
}

export function makeAddMessageToConversationRoute({
  store,
  conversations,
  llm,
  dataStreamer,
  embed,
  findNearestNeighborsOptions,
  searchBoosters,
  userQueryPreprocessor,
}: AddMessageToConversationRouteParams) {
  return async (
    req: ExpressRequest,
    res: ExpressResponse<ApiMessage>,
    next: NextFunction
  ) => {
    const reqId = getRequestId(req);
    try {
      const {
        params: { conversationId: conversationIdString },
        body: { message },
        query: { stream },
        ip,
      } = req;

      let conversationId: ObjectId;
      try {
        conversationId = new ObjectId(conversationIdString);
      } catch (err) {
        return sendErrorResponse({
          reqId,
          res,
          httpStatus: 400,
          errorMessage: "Invalid conversation ID",
        });
      }

      if (!isValidIp(ip)) {
        return sendErrorResponse({
          reqId,
          res,
          httpStatus: 400,
          errorMessage: `Invalid IP address ${ip}`,
        });
      }

      const shouldStream = Boolean(stream);
      const latestMessageText = message;
      if (latestMessageText.length > MAX_INPUT_LENGTH) {
        return sendErrorResponse({
          reqId,
          res,
          httpStatus: 400,
          errorMessage: "Message too long",
        });
      }

      let conversationInDb: Conversation | null;
      try {
        conversationInDb = await conversations.findById({
          _id: conversationId,
        });
      } catch (err) {
        return sendErrorResponse({
          reqId,
          res,
          httpStatus: 500,
          errorMessage: "Error finding conversation",
        });
      }

      if (!conversationInDb) {
        return sendErrorResponse({
          reqId,
          res,
          httpStatus: 404,
          errorMessage: "Conversation not found",
        });
      }
      if (!areEquivalentIpAddresses(conversationInDb.ipAddress, ip)) {
        return sendErrorResponse({
          reqId,
          res,
          httpStatus: 403,
          errorMessage: "IP address does not match",
        });
      }

      if (conversationInDb.messages.length >= MAX_MESSAGES_IN_CONVERSATION) {
        // The end user doesn't see the system prompt, so we subtract 1 to account for that.
        const numMessagesVisibleToUser = MAX_MESSAGES_IN_CONVERSATION - 1;
        return sendErrorResponse({
          reqId,
          res,
          httpStatus: 400,
          errorMessage: `Max messages (${numMessagesVisibleToUser}) exceeded. You cannot send more messages in this conversation.`,
        });
      }

      let answer: OpenAiChatMessage;

      let preprocessedUserMessageContent: string | undefined;
      // Try to preprocess the user's message. If the user's message cannot be preprocessed
      // (likely due to LLM timeout), then we will just use the original message.
      if (userQueryPreprocessor) {
        try {
          const { query, doNotAnswer } = await userQueryPreprocessor({
            query: latestMessageText,
            messages: conversationInDb.messages,
          });
          preprocessedUserMessageContent = query;
          logRequest({
            reqId,
            message: stripIndent`Successfully preprocessed user query.
              Original query: ${latestMessageText}
              Preprocessed query: ${preprocessedUserMessageContent}`,
          });
          if (doNotAnswer) {
            return await sendStaticNonResponse({
              conversations,
              conversationId,
              preprocessedUserMessageContent,
              latestMessageText,
              shouldStream,
              dataStreamer,
              res,
            });
          }
        } catch (err: unknown) {
          logRequest({
            reqId,
            type: "error",
            message: `Error preprocessing query: ${JSON.stringify(
              err
            )}. Using original query: ${latestMessageText}`,
          });
        }
      }
      // Find content matches for latest message
      let chunks: WithScore<EmbeddedContent>[];
      try {
        const { embedding, results } = await getContentForText({
          embed,
          ipAddress: ip,
          text: preprocessedUserMessageContent || latestMessageText,
          store,
          findNearestNeighborsOptions,
        });
        chunks = results;
        if (searchBoosters?.length) {
          for (const booster of searchBoosters) {
            if (booster.shouldBoost({ text: latestMessageText })) {
              chunks = await booster.boost({
                existingResults: chunks,
                embedding,
                store,
              });
            }
          }
        }
      } catch (err) {
        return sendErrorResponse({
          reqId,
          res,
          httpStatus: 500,
          errorMessage: "Error getting content for text",
          errorDetails: JSON.stringify(err),
        });
      }
      if (!chunks || chunks.length === 0) {
        logRequest({
          reqId,
          message: "No matching content found",
        });
        return await sendStaticNonResponse({
          conversations,
          conversationId,
          preprocessedUserMessageContent,
          latestMessageText,
          shouldStream,
          dataStreamer,
          res,
        });
      }

      const references = generateReferences({ chunks });

      const chunkTexts = chunks.map((chunk) => chunk.text);

      const latestMessage = {
        content: preprocessedUserMessageContent || latestMessageText,
        role: "user",
      } satisfies OpenAiChatMessage;

      const messages = [
        ...conversationInDb.messages.map(convertDbMessageToOpenAiMessage),
        latestMessage,
      ] satisfies OpenAiChatMessage[];

      let answerContent;
      if (shouldStream) {
        const answerStream = await llm.answerQuestionStream({
          messages,
          chunks: chunkTexts,
        });
        dataStreamer.connect(res);
        answerContent = await dataStreamer.stream({
          stream: answerStream,
        });
        logRequest({
          reqId,
          message: `LLM response: ${JSON.stringify(answerContent)}`,
        });
        await dataStreamer.streamData({
          type: "references",
          data: references,
        });
      } else {
        try {
          const messages = [
            ...conversationInDb.messages.map(convertDbMessageToOpenAiMessage),
            latestMessage,
          ];
          logRequest({
            reqId,
            message: `LLM query: ${JSON.stringify(messages)}`,
          });
          answer = await llm.answerQuestionAwaited({
            messages,
            chunks: chunkTexts,
          });
          logRequest({
            reqId,
            message: `LLM response: ${JSON.stringify(answer)}`,
          });
          answerContent = answer.content;
        } catch (err) {
          const errorMessage =
            err instanceof Error ? err.message : JSON.stringify(err);
          logRequest({
            reqId: req.headers["req-id"] as string,
            message: `LLM error: ${errorMessage}`,
            type: "error",
          });
          logRequest({
            reqId,
            message: "Only sending vector search results to user",
          });
          answer = {
            role: "assistant",
            content: conversationConstants.LLM_NOT_WORKING,
          } satisfies OpenAiChatMessage;
          answerContent = answer.content;
        }
      }

      if (!answerContent) {
        throw new Error("No answer content");
      }

      const { assistantMessage } = await addMessagesToDatabase({
        conversations,
        conversationId,
        originalUserMessageContent: message,
        preprocessedUserMessageContent,
        assistantMessageContent: answerContent,
        assistantMessageReferences: references,
      });

      const apiRes = convertMessageFromDbToApi(assistantMessage);
      if (shouldStream) {
        dataStreamer.streamData({
          type: "finished",
          data: apiRes.id,
        });
        dataStreamer.disconnect();
        return;
      } else {
        res.status(200).json(apiRes);
      }
    } catch (err) {
      logRequest({
        reqId,
        message: "An unexpected error occurred: " + JSON.stringify(err),
        type: "error",
      });
      if (dataStreamer.connected) {
        dataStreamer.disconnect();
      }
      next(err);
    }
  };
}

export interface GetContentForTextParams {
  embed: EmbedFunc;
  ipAddress: string;
  text: string;
  store: EmbeddedContentStore;
  findNearestNeighborsOptions?: Partial<FindNearestNeighborsOptions>;
}

export async function sendStaticNonResponse({
  conversations,
  conversationId,
  preprocessedUserMessageContent,
  latestMessageText,
  shouldStream,
  dataStreamer,
  res,
}: {
  conversations: ConversationsService;
  conversationId: ObjectId;
  preprocessedUserMessageContent?: string;
  latestMessageText: string;
  shouldStream: boolean;
  dataStreamer: DataStreamer;
  res: ExpressResponse<ApiMessage>;
}) {
  const { assistantMessage } = await addMessagesToDatabase({
    conversations,
    conversationId,
    preprocessedUserMessageContent: preprocessedUserMessageContent,
    originalUserMessageContent: latestMessageText,
    assistantMessageContent: conversationConstants.NO_RELEVANT_CONTENT,
    assistantMessageReferences: [],
  });
  const apiRes = convertMessageFromDbToApi(assistantMessage);
  if (shouldStream) {
    dataStreamer.connect(res);
    dataStreamer.streamData({
      type: "delta",
      data: apiRes.content,
    });
    dataStreamer.streamData({
      type: "finished",
      data: apiRes.id,
    });
    dataStreamer.disconnect();
    return;
  } else {
    return res.status(200).json(apiRes);
  }
}

export function convertDbMessageToOpenAiMessage(
  message: Message
): OpenAiChatMessage {
  return {
    content: message.content,
    role: message.role as OpenAiMessageRole,
  };
}

export async function getContentForText({
  embed,
  store,
  text,
  ipAddress,
  findNearestNeighborsOptions,
}: GetContentForTextParams) {
  const { embedding } = await embed({
    text,
    userIp: ipAddress,
  });

  const results = await store.findNearestNeighbors(
    embedding,
    findNearestNeighborsOptions
  );
  return { embedding, results };
}

interface AddMessagesToDatabaseParams {
  conversationId: ObjectId;
  originalUserMessageContent: string;
  preprocessedUserMessageContent?: string;
  assistantMessageContent: string;
  assistantMessageReferences: References;
  conversations: ConversationsService;
}
export async function addMessagesToDatabase({
  conversationId,
  originalUserMessageContent,
  preprocessedUserMessageContent,
  assistantMessageContent,
  assistantMessageReferences,
  conversations,
}: AddMessagesToDatabaseParams) {
  // TODO: consider refactoring addConversationMessage to take in an array of messages.
  // Would limit database calls.
  const userMessage = await conversations.addConversationMessage({
    conversationId,
    content: originalUserMessageContent,
    preprocessedContent: preprocessedUserMessageContent,
    role: "user",
  });
  const assistantMessage = await conversations.addConversationMessage({
    conversationId,
    content: assistantMessageContent,
    role: "assistant",
    references: assistantMessageReferences,
  });
  return { userMessage, assistantMessage };
}

export const createLinkReference = (link: string): Reference => {
  const url = new URL(link);
  url.searchParams.append("tck", "docs_chatbot");
  return {
    url: url.href,
    title: url.origin + url.pathname,
  };
};

export interface GenerateReferencesParams {
  chunks: EmbeddedContent[];
}

export function generateReferences({
  chunks,
}: GenerateReferencesParams): References {
  if (chunks.length === 0) {
    return [];
  }
  const uniqueLinks = Array.from(new Set(chunks.map((chunk) => chunk.url)));
  return uniqueLinks.map((link) => createLinkReference(link));
}

export function validateApiConversationFormatting({
  conversation,
}: {
  conversation: ApiConversation;
}) {
  const { messages } = conversation;
  if (
    messages?.length === 0 || // Must be messages in the conversation
    messages.length % 2 !== 0 // Must be an even number of messages
  ) {
    return false;
  }
  // Must alternate between assistant and user
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const isAssistant = i % 2 === 0;
    if (isAssistant && message.role !== "assistant") {
      return false;
    }
    if (!isAssistant && message.role !== "user") {
      return false;
    }
  }

  return true;
}
