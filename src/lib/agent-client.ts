/**
 * AgentCore Runtime への SSE リクエスト
 * JWT Authorizer が設定されているため Bearer トークンを添付
 * セッション ID は 33 文字以上が必須
 */
import { fetchAuthSession } from 'aws-amplify/auth';
import { CONFIG } from '../config';

export interface AgentEvent {
  type: 'text' | 'tool_use' | 'error' | 'done';
  data?: string;
  error?: string;
}

export async function* invokeAgent(
  prompt: string,
  sessionId: string,
): AsyncGenerator<AgentEvent> {
  // アクセストークン取得（cognito:groups が含まれている）
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) throw new Error('未認証: アクセストークンが取得できませんでした');

  const region = CONFIG.agentRuntimeArn.split(':')[3];
  const encodedArn = encodeURIComponent(CONFIG.agentRuntimeArn);
  const url = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodedArn}/invocations?qualifier=DEFAULT`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
    },
    body: JSON.stringify({ prompt, session_id: sessionId }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`AgentCore エラー (${res.status}): ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        yield { type: 'done' };
        return;
      }
      try {
        const event = JSON.parse(data) as AgentEvent;
        yield event;
      } catch {
        // 無効な JSON は無視
      }
    }
  }
}

/** セッション ID を生成（33 文字以上の UUID ベース） */
export function generateSessionId(): string {
  return `session-${crypto.randomUUID()}-${Date.now()}`;
}
