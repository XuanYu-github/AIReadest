import { validateUserAndToken } from '@/utils/access';

type IncomingMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType?: string };

type IncomingMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | IncomingMessagePart[];
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
    const response =
      provider === 'ollama'
        ? await fetch(`${String(baseUrl).trim().replace(/\/+$/, '')}/api/chat`, {
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
                          (part): part is Extract<IncomingMessagePart, { type: 'text' }> =>
                            part.type === 'text',
                        )
                        .map((part) => part.text)
                        .join('\n'),
              })),
              options: maxOutputTokens ? { num_predict: maxOutputTokens } : undefined,
            }),
          })
        : await fetch(`${String(baseUrl).trim().replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${String(apiKey)}`,
            },
            body: JSON.stringify({
              model,
              messages: toOpenAICompatibleMessages(fullMessages),
              max_tokens: maxOutputTokens,
              reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
            }),
          });

    const rawText = await response.text();
    let parsed:
      | {
          choices?: Array<{ message?: { content?: string } }>;
          message?: { content?: string };
          error?: string | { message?: string };
        }
      | null = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText) as {
          choices?: Array<{ message?: { content?: string } }>;
          message?: { content?: string };
          error?: string | { message?: string };
        };
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const parsedError =
        typeof parsed?.error === 'string'
          ? parsed.error
          : parsed?.error?.message;
      const errorMessage = parsedError || rawText?.slice(0, 200) || response.statusText;
      return new Response(JSON.stringify({ error: errorMessage }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const content =
      provider === 'ollama'
        ? ((parsed as { message?: { content?: string } } | null)?.message?.content || '')
        : (parsed?.choices?.[0]?.message?.content || '');
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
