import { validateUserAndToken } from '@/utils/access';

type IncomingMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType?: string };

type IncomingMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | IncomingMessagePart[];
};

const toResponsesInput = (messages: IncomingMessage[]) =>
  messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === 'string'
        ? [{ type: (message.role === 'assistant' ? 'output_text' : 'input_text') as 'input_text' | 'output_text', text: message.content }]
        : message.content.map((part) =>
            part.type === 'text'
              ? {
                  type: (message.role === 'assistant' ? 'output_text' : 'input_text') as 'input_text' | 'output_text',
                  text: part.text,
                }
              : { type: 'input_image' as const, image_url: part.image },
          ),
  }));

const extractResponsesContent = (parsed: unknown): string => {
  if (!parsed || typeof parsed !== 'object') return '';
  const record = parsed as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text.trim();
  }

  const chunks =
    record.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text?.trim() || '')
      .filter(Boolean) ?? [];

  return chunks.join('\n\n').trim();
};

const extractChatCompletionsContent = (parsed: unknown): string => {
  if (!parsed || typeof parsed !== 'object') return '';
  const record = parsed as { choices?: Array<{ message?: { content?: string } }> };
  const content = record.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
};

const extractErrorMessage = (parsed: unknown): string => {
  if (!parsed || typeof parsed !== 'object') return '';
  const error = (parsed as { error?: unknown }).error;
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return '';
};

const isUnsupportedLegacyProtocolError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('unsupported legacy protocol') ||
    (normalized.includes('/v1/chat/completions') && normalized.includes('not supported')) ||
    (normalized.includes('please use') && normalized.includes('/v1/responses'))
  );
};

const toOpenAICompatibleMessages = (messages: IncomingMessage[]) => {
  return messages.map((message) => {
    if (typeof message.content === 'string') {
      return message;
    }

    if (message.role === 'user') {
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type === 'text') {
            return { type: 'text', text: part.text };
          }

          return {
            type: 'image_url',
            image_url: {
              url: part.image,
            },
          };
        }),
      };
    }

    return {
      ...message,
      content: message.content
        .filter((part): part is Extract<IncomingMessagePart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    };
  });
};

const requestOpenAICompatible = async ({
  normalizedBaseUrl,
  apiKey,
  model,
  fullMessages,
  maxOutputTokens,
  reasoningEffort,
  useResponsesApi,
}: {
  normalizedBaseUrl: string;
  apiKey: string;
  model: string;
  fullMessages: IncomingMessage[];
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  useResponsesApi: boolean;
}) => {
  const response = await fetch(`${normalizedBaseUrl}${useResponsesApi ? '/responses' : '/chat/completions'}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(
      useResponsesApi
        ? {
            model,
            input: toResponsesInput(fullMessages),
            max_output_tokens: maxOutputTokens,
            reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
          }
        : {
            model,
            messages: toOpenAICompatibleMessages(fullMessages),
            max_tokens: maxOutputTokens,
            reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
          },
    ),
  });

  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }

  const content = useResponsesApi ? extractResponsesContent(parsed) : extractChatCompletionsContent(parsed);
  const errorMessage = extractErrorMessage(parsed) || rawText.slice(0, 200) || response.statusText;

  return {
    response,
    parsed,
    rawText,
    content,
    errorMessage,
  };
};

export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.text();
    let parsedBody: {
      provider?: unknown;
      messages?: unknown;
      system?: unknown;
      apiKey?: unknown;
      model?: unknown;
      baseUrl?: unknown;
      maxOutputTokens?: unknown;
      reasoningEffort?: unknown;
    };

    try {
      parsedBody = rawBody ? (JSON.parse(rawBody) as typeof parsedBody) : {};
    } catch (e) {
      return new Response(
        JSON.stringify({
          error:
            `Invalid JSON request body: ${(e as Error).message}. ` +
            `Body starts with: ${JSON.stringify(rawBody.slice(0, 40))}`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const provider = typeof parsedBody.provider === 'string' ? parsedBody.provider : 'openai-compatible';
    const messages = parsedBody.messages as unknown;
    const system = typeof parsedBody.system === 'string' ? parsedBody.system : undefined;
    const apiKey = typeof parsedBody.apiKey === 'string' ? parsedBody.apiKey : undefined;
    const model = typeof parsedBody.model === 'string' ? parsedBody.model : undefined;
    const baseUrl = typeof parsedBody.baseUrl === 'string' ? parsedBody.baseUrl : undefined;
    const maxOutputTokens =
      typeof parsedBody.maxOutputTokens === 'number' ? parsedBody.maxOutputTokens : undefined;
    const reasoningEffort =
      parsedBody.reasoningEffort === 'low' ||
      parsedBody.reasoningEffort === 'medium' ||
      parsedBody.reasoningEffort === 'high'
        ? parsedBody.reasoningEffort
        : undefined;

    if (!baseUrl) {
      const { user, token } = await validateUserAndToken(req.headers.get('authorization'));
      if (!user || !token) {
        return Response.json({ error: 'Not authenticated' }, { status: 403 });
      }
      return Response.json({ error: 'Gateway mode is not available in this project' }, { status: 501 });
    }

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'Messages required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (provider !== 'ollama' && !apiKey) {
      return new Response(JSON.stringify({ error: 'API key required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!model) {
      return new Response(JSON.stringify({ error: 'Model required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const fullMessages: IncomingMessage[] = system
      ? ([{ role: 'system', content: system }, ...(messages as IncomingMessage[])] as IncomingMessage[])
      : (messages as IncomingMessage[]);
    const normalizedBaseUrl = String(baseUrl).trim().replace(/\/+$/, '');
    const preferredResponsesApi = provider !== 'ollama' && (!!reasoningEffort || /^gpt-5/i.test(String(model)));

    let response: Response;
    let parsed: unknown = null;
    let rawText = '';
    let useResponsesApi = preferredResponsesApi;

    if (provider === 'ollama') {
      response = await fetch(`${normalizedBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          messages: fullMessages.map((message) => ({
            role: message.role,
            content:
              typeof message.content === 'string'
                ? message.content
                : message.content
                    .filter(
                      (part): part is Extract<IncomingMessagePart, { type: 'text' }> => part.type === 'text',
                    )
                    .map((part) => part.text)
                    .join('\n'),
          })),
          options: maxOutputTokens ? { num_predict: maxOutputTokens } : undefined,
        }),
      });

      rawText = await response.text();
      if (rawText) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }
      }
    } else {
      let result = await requestOpenAICompatible({
        normalizedBaseUrl,
        apiKey: String(apiKey),
        model: String(model),
        fullMessages,
        maxOutputTokens,
        reasoningEffort,
        useResponsesApi,
      });

      if (!useResponsesApi && !result.response.ok && isUnsupportedLegacyProtocolError(result.errorMessage)) {
        useResponsesApi = true;
        result = await requestOpenAICompatible({
          normalizedBaseUrl,
          apiKey: String(apiKey),
          model: String(model),
          fullMessages,
          maxOutputTokens,
          reasoningEffort,
          useResponsesApi,
        });
      }

      response = result.response;
      parsed = result.parsed;
      rawText = result.rawText;
    }

    if (!response.ok) {
      const parsedError = extractErrorMessage(parsed);
      const errorMessage = parsedError || rawText?.slice(0, 200) || response.statusText;
      return new Response(JSON.stringify({ error: errorMessage }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const content =
      provider === 'ollama'
        ? ((parsed as { message?: { content?: string } } | null)?.message?.content || '')
        : useResponsesApi
          ? extractResponsesContent(parsed)
          : extractChatCompletionsContent(parsed);
    if (!content) {
      return new Response(JSON.stringify({ error: 'Empty response from upstream' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: `Chat failed: ${errorMessage}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
