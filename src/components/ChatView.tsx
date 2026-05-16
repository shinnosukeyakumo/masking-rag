import React, { useState, useRef, useEffect } from 'react';
import { signOut } from 'aws-amplify/auth';
import { invokeAgent, generateSessionId } from '../lib/agent-client';

type MessageKind = 'user' | 'assistant' | 'tool';

interface Message {
  kind: MessageKind;
  content: string;
  toolName?: string;
  isStreaming?: boolean;
}

interface ChatViewProps {
  userRole: string;
}

export function ChatView({ userRole }: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const sessionIdRef = useRef(generateSessionId());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const isManager = userRole === 'manager';
  const roleLabel = isManager ? '管理職' : '一般職';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setIsLoading(true);

    setMessages(prev => [
      ...prev,
      { kind: 'user', content: userMessage },
      { kind: 'assistant', content: '', isStreaming: true },
    ]);

    try {
      let lastKind: MessageKind = 'assistant';

      for await (const event of invokeAgent(userMessage, sessionIdRef.current)) {
        if (event.type === 'text' && event.data) {
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            // 直前が tool だった場合は新規 assistant メッセージとして開始
            if (lastKind === 'tool' || last.kind !== 'assistant') {
              updated.push({ kind: 'assistant', content: event.data!, isStreaming: true });
              lastKind = 'assistant';
            } else {
              updated[updated.length - 1] = {
                ...last,
                content: last.content + event.data,
                isStreaming: true,
              };
            }
            return updated;
          });
        } else if (event.type === 'tool_use') {
          // 直前の assistant メッセージを確定し、tool 実行表示を追加
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.kind === 'assistant') {
              updated[updated.length - 1] = { ...last, isStreaming: false };
            }
            updated.push({
              kind: 'tool',
              content: 'ナレッジベースを検索しています…',
              toolName: event.data,
            });
            return updated;
          });
          lastKind = 'tool';
        } else if (event.type === 'done') {
          break;
        } else if (event.type === 'error') {
          setMessages(prev => {
            const updated = [...prev];
            updated.push({
              kind: 'assistant',
              content: `エラー: ${event.error}`,
              isStreaming: false,
            });
            return updated;
          });
        }
      }

      // 最後のメッセージのストリーミング状態を解除
      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last.kind === 'assistant') {
          updated[updated.length - 1] = {
            ...last,
            content: last.content || '（応答がありませんでした）',
            isStreaming: false,
          };
        }
        // tool 完了表示
        for (let i = 0; i < updated.length; i++) {
          if (updated[i].kind === 'tool') {
            updated[i] = { ...updated[i], content: '検索完了' };
          }
        }
        return updated;
      });
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {
          kind: 'assistant',
          content: `エラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
          isStreaming: false,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        {/* ヘッダー */}
        <header style={styles.header}>
          <div style={styles.headerLeft}>
            <div style={styles.logo}>🔍</div>
            <div>
              <h1 style={styles.title}>社内情報検索 RAG</h1>
              <p style={styles.subtitle}>ロールベース・マスキング対応アシスタント</p>
            </div>
          </div>
          <div style={styles.headerRight}>
            <span style={{
              ...styles.roleBadge,
              background: isManager
                ? 'linear-gradient(135deg, #f59e0b, #d97706)'
                : 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
            }}>
              <span style={styles.roleDot} />
              {roleLabel}
            </span>
            <button onClick={() => signOut()} style={styles.logoutButton}>
              ログアウト
            </button>
          </div>
        </header>

        {/* メッセージ一覧 */}
        <div style={styles.messageArea}>
          {messages.length === 0 && (
            <div style={styles.welcomeWrap}>
              <div style={styles.welcomeIcon}>💬</div>
              <h2 style={styles.welcomeTitle}>こんにちは！</h2>
              <p style={styles.welcomeSubtitle}>
                社内ドキュメントについて、なんでも質問してください
              </p>
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* 入力フォーム */}
        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            style={styles.input}
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="社内ドキュメントを検索..."
            disabled={isLoading}
            autoFocus
          />
          <button
            type="submit"
            style={{
              ...styles.button,
              opacity: isLoading || !input.trim() ? 0.5 : 1,
              cursor: isLoading || !input.trim() ? 'not-allowed' : 'pointer',
            }}
            disabled={isLoading || !input.trim()}
          >
            {isLoading ? (
              <span style={styles.spinner} />
            ) : (
              <>送信 <span style={{ marginLeft: 4 }}>→</span></>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.kind === 'user') {
    return (
      <div style={styles.userWrap}>
        <div style={styles.userBubble}>
          <p style={styles.msgText}>{message.content}</p>
        </div>
        <div style={styles.userAvatar}>👤</div>
      </div>
    );
  }

  if (message.kind === 'tool') {
    return (
      <div style={styles.toolWrap}>
        <div style={styles.toolBubble}>
          <span style={styles.toolIcon}>🔎</span>
          <span style={styles.toolText}>{message.content}</span>
          {message.content !== '検索完了' && <span style={styles.dotPulse} />}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.assistantWrap}>
      <div style={styles.assistantAvatar}>🤖</div>
      <div style={styles.assistantBubble}>
        <p style={styles.msgText}>
          {message.content}
          {message.isStreaming && <span style={styles.cursor}>▍</span>}
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #eef2ff 0%, #f0f9ff 50%, #ecfeff 100%)',
    padding: 16,
    fontFamily: '"Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif',
  },
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 32px)',
    maxWidth: 900,
    margin: '0 auto',
    background: 'rgba(255, 255, 255, 0.7)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    borderRadius: 24,
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(255, 255, 255, 0.5)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 24px',
    background: 'linear-gradient(135deg, #1e293b 0%, #334155 100%)',
    color: '#fff',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 14 },
  logo: {
    width: 42,
    height: 42,
    borderRadius: 12,
    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    boxShadow: '0 4px 12px rgba(99, 102, 241, 0.4)',
  },
  title: { margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: 0.5 },
  subtitle: { margin: 0, fontSize: 11, opacity: 0.7, marginTop: 2 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12 },
  roleBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    padding: '6px 12px',
    borderRadius: 999,
    color: '#fff',
    fontWeight: 600,
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
  },
  roleDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    background: '#fff',
    boxShadow: '0 0 0 2px rgba(255,255,255,0.3)',
  },
  logoutButton: {
    background: 'rgba(255, 255, 255, 0.1)',
    color: '#fff',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: 8,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    fontWeight: 500,
  },
  messageArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  welcomeWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    textAlign: 'center',
    padding: 40,
  },
  welcomeIcon: { fontSize: 56, marginBottom: 16 },
  welcomeTitle: { margin: 0, fontSize: 22, color: '#1e293b' },
  welcomeSubtitle: { margin: '8px 0 0', color: '#64748b', fontSize: 14 },
  userWrap: { display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-end', gap: 8 },
  userBubble: {
    background: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)',
    color: '#fff',
    borderRadius: '20px 20px 4px 20px',
    padding: '12px 18px',
    maxWidth: '70%',
    boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)',
    animation: 'slideInRight 0.3s ease-out',
  },
  userAvatar: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    flexShrink: 0,
  },
  assistantWrap: { display: 'flex', alignItems: 'flex-end', gap: 8 },
  assistantAvatar: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #10b981, #06b6d4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    flexShrink: 0,
  },
  assistantBubble: {
    background: '#fff',
    color: '#1e293b',
    border: '1px solid #e2e8f0',
    borderRadius: '20px 20px 20px 4px',
    padding: '12px 18px',
    maxWidth: '75%',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
    animation: 'slideInLeft 0.3s ease-out',
  },
  toolWrap: { display: 'flex', justifyContent: 'center', margin: '4px 0' },
  toolBubble: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: 'rgba(99, 102, 241, 0.08)',
    color: '#4f46e5',
    border: '1px solid rgba(99, 102, 241, 0.2)',
    borderRadius: 999,
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 500,
    animation: 'fadeIn 0.3s',
  },
  toolIcon: { fontSize: 14 },
  toolText: { letterSpacing: 0.3 },
  dotPulse: {
    width: 6,
    height: 6,
    borderRadius: 999,
    background: '#6366f1',
    animation: 'pulse 1.2s infinite',
  },
  msgText: { margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: 14 },
  cursor: {
    display: 'inline-block',
    marginLeft: 2,
    animation: 'blink 1s step-end infinite',
    color: '#6366f1',
    fontWeight: 700,
  },
  form: {
    display: 'flex',
    gap: 10,
    padding: '16px 20px',
    borderTop: '1px solid rgba(226, 232, 240, 0.6)',
    background: 'rgba(255, 255, 255, 0.6)',
  },
  input: {
    flex: 1,
    padding: '12px 18px',
    border: '1px solid #cbd5e1',
    borderRadius: 999,
    fontSize: 15,
    outline: 'none',
    background: '#fff',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
    fontFamily: 'inherit',
  },
  button: {
    padding: '12px 24px',
    background: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)',
    color: '#fff',
    border: 'none',
    borderRadius: 999,
    fontSize: 14,
    fontWeight: 600,
    minWidth: 100,
    boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinner: {
    width: 16,
    height: 16,
    border: '2px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
};
