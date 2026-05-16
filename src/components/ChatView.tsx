import React, { useState, useRef, useEffect } from 'react';
import { invokeAgent, generateSessionId } from '../lib/agent-client';

interface Message {
  role: 'user' | 'assistant';
  content: string;
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

  const roleLabel = userRole === 'manager' ? '管理職' : '一般職';
  const roleBadgeColor = userRole === 'manager' ? '#b45309' : '#1d4ed8';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);

    const assistantIndex = messages.length + 1;
    setMessages(prev => [...prev, { role: 'assistant', content: '', isStreaming: true }]);
    setIsLoading(true);

    try {
      let fullText = '';
      for await (const event of invokeAgent(userMessage, sessionIdRef.current)) {
        if (event.type === 'text' && event.data) {
          fullText += event.data;
          setMessages(prev => {
            const updated = [...prev];
            updated[assistantIndex] = {
              role: 'assistant',
              content: fullText,
              isStreaming: true,
            };
            return updated;
          });
        } else if (event.type === 'done') {
          break;
        } else if (event.type === 'error') {
          fullText += `\n[エラー: ${event.error}]`;
        }
      }
      setMessages(prev => {
        const updated = [...prev];
        updated[assistantIndex] = {
          role: 'assistant',
          content: fullText || '（応答がありませんでした）',
          isStreaming: false,
        };
        return updated;
      });
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev];
        updated[assistantIndex] = {
          role: 'assistant',
          content: `エラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
          isStreaming: false,
        };
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      {/* ヘッダー */}
      <div style={styles.header}>
        <span style={styles.title}>社内情報検索 RAG</span>
        <span style={{ ...styles.roleBadge, backgroundColor: roleBadgeColor }}>
          {roleLabel}
        </span>
      </div>

      {/* メッセージ一覧 */}
      <div style={styles.messageArea}>
        {messages.length === 0 && (
          <p style={styles.placeholder}>質問を入力してください</p>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={msg.role === 'user' ? styles.userBubbleWrap : styles.assistantBubbleWrap}>
            <div style={msg.role === 'user' ? styles.userBubble : styles.assistantBubble}>
              <span style={styles.roleTag}>{msg.role === 'user' ? 'あなた' : 'AI'}</span>
              <p style={styles.msgText}>
                {msg.content}
                {msg.isStreaming && <span style={styles.cursor}>▍</span>}
              </p>
            </div>
          </div>
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
        />
        <button type="submit" style={styles.button} disabled={isLoading || !input.trim()}>
          {isLoading ? '送信中…' : '送信'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    maxWidth: 800,
    margin: '0 auto',
    fontFamily: 'system-ui, sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 20px',
    background: '#1e293b',
    color: '#fff',
  },
  title: { fontSize: 18, fontWeight: 700 },
  roleBadge: {
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 999,
    color: '#fff',
    fontWeight: 600,
  },
  messageArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    background: '#f8fafc',
  },
  placeholder: { color: '#94a3b8', textAlign: 'center', marginTop: 60 },
  userBubbleWrap: { display: 'flex', justifyContent: 'flex-end' },
  assistantBubbleWrap: { display: 'flex', justifyContent: 'flex-start' },
  userBubble: {
    background: '#3b82f6',
    color: '#fff',
    borderRadius: '18px 18px 4px 18px',
    padding: '10px 16px',
    maxWidth: '75%',
  },
  assistantBubble: {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: '18px 18px 18px 4px',
    padding: '10px 16px',
    maxWidth: '80%',
    boxShadow: '0 1px 2px rgba(0,0,0,.06)',
  },
  roleTag: { fontSize: 11, opacity: 0.7, display: 'block', marginBottom: 4 },
  msgText: { margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6 },
  cursor: { animation: 'blink 1s step-end infinite' },
  form: {
    display: 'flex',
    gap: 8,
    padding: '12px 16px',
    borderTop: '1px solid #e2e8f0',
    background: '#fff',
  },
  input: {
    flex: 1,
    padding: '10px 14px',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    fontSize: 15,
    outline: 'none',
  },
  button: {
    padding: '10px 20px',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
