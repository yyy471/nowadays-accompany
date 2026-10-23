import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage, usePoll } from '../hooks';
import type {
  AccountsResponse,
  ConversationRef,
  ConversationsResponse,
  InstanceStatus,
  MessageSegment,
  MessagesResponse,
  SlotsResponse,
  StreamEvent
} from '../types';
import { Button, Card, ControlButton, Empty, ErrorNote, Icon, IconButton, Input, Select, StatePill, Textarea, formatTime } from '../ui';

interface MessagesPageProps {
  slots?: SlotsResponse;
  lastEvent?: StreamEvent;
}

function conversationKey(conversation: ConversationRef): string {
  return `${conversation.kind}:${conversation.peerId}`;
}

function conversationLabel(conversation: ConversationRef): string {
  return `${conversation.kind === 'group' ? '群' : '私聊'} ${conversation.peerId}`;
}

function segmentText(segment: MessageSegment): { text: string; className?: string } {
  const data = segment.data;
  switch (segment.type) {
    case 'text':
      return { text: String(data.text ?? '') };
    case 'at':
      return { text: `@${String(data.qq ?? '')}`, className: 'seg-at' };
    case 'image':
      return { text: '[图片]', className: 'seg-media' };
    case 'face':
      return { text: '[表情]', className: 'seg-media' };
    case 'reply':
      return { text: '[回复]', className: 'seg-media' };
    case 'record':
      return { text: '[语音]', className: 'seg-media' };
    case 'video':
      return { text: '[视频]', className: 'seg-media' };
    case 'file':
      return { text: '[文件]', className: 'seg-media' };
    case 'json':
    case 'xml':
      return { text: '[卡片消息]', className: 'seg-media' };
    default:
      return { text: `[${segment.type}]`, className: 'seg-media' };
  }
}

function currentInstance(slots: SlotsResponse | undefined, accountId: string): InstanceStatus | undefined {
  return (slots?.slots ?? []).find((instance) => instance.accountId === accountId);
}

export function MessagesPage({ slots, lastEvent }: MessagesPageProps) {
  const accounts = usePoll<AccountsResponse>('/accounts', 10000);
  const [accountId, setAccountId] = useState('');
  const [conversation, setConversation] = useState<ConversationRef>();
  const [draft, setDraft] = useState('');
  const [composeKind, setComposeKind] = useState<'private' | 'group'>('private');
  const [composePeer, setComposePeer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const threadRef = useRef<HTMLDivElement>(null);
  const lastRefresh = useRef(0);

  const accountList = accounts.data?.accounts ?? [];

  useEffect(() => {
    if (!accountId && accountList.length > 0) setAccountId(accountList[0]!.accountId);
  }, [accountId, accountList]);

  const conversations = usePoll<ConversationsResponse>(
    accountId ? `/conversations?accountId=${encodeURIComponent(accountId)}` : null,
    6000
  );

  const conversationList = conversations.data?.conversations ?? [];

  useEffect(() => {
    setConversation(undefined);
    setDraft('');
    setNotice(undefined);
  }, [accountId]);

  useEffect(() => {
    if (!conversation && conversationList.length > 0 && conversationList[0]?.accountId === accountId) {
      setConversation(conversationList[0]);
    }
  }, [accountId, conversation, conversationList]);

  const activeConversation = conversation && conversation.accountId === accountId ? conversation : undefined;
  const messagesPath = activeConversation
    ? `/accounts/${encodeURIComponent(accountId)}/conversations/${activeConversation.kind}/${encodeURIComponent(activeConversation.peerId)}/messages?limit=200`
    : null;
  const messages = usePoll<MessagesResponse>(messagesPath, 5000);

  const instance = currentInstance(slots, accountId);
  const online = instance?.state === 'online' || instance?.state === 'degraded';

  useEffect(() => {
    if (!lastEvent || !activeConversation || !instance) return;
    if (lastEvent.type !== 'channel:inbound' && lastEvent.type !== 'channel:outbound') return;
    if (lastEvent.payload.instanceId !== instance.id) return;
    const incoming = lastEvent.payload.conversation as ConversationRef | undefined;
    if (!incoming || conversationKey(incoming) !== conversationKey(activeConversation)) return;
    const now = Date.now();
    if (now - lastRefresh.current < 250) return;
    lastRefresh.current = now;
    void messages.refresh();
  }, [lastEvent, activeConversation, instance, messages.refresh]);

  const messageList = messages.data?.messages ?? [];

  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messageList.length, activeConversation?.peerId]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !activeConversation || !instance) return;
    if (!online) {
      setError('实例不在线，暂时不能发送。');
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api(`/slots/${encodeURIComponent(instance.id)}/send`, {
        method: 'POST',
        body: JSON.stringify({
          kind: activeConversation.kind,
          peerId: activeConversation.peerId,
          text
        })
      });
      setDraft('');
      await messages.refresh();
      setNotice('已发送');
      window.setTimeout(() => setNotice(undefined), 2500);
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setBusy(false);
    }
  };

  const openConversation = (): void => {
    const peerId = composePeer.trim();
    if (!peerId) {
      setError('填写会话 ID（群号或 QQ 号）。');
      return;
    }
    setConversation({ accountId, kind: composeKind, peerId });
    setComposePeer('');
    setError(undefined);
  };

  return (
    <div className="page-stack messages-page">
      <div className="message-toolbar">
        <div className="toolbar-group">
          <span className="meta-label">账号</span>
          <Select aria-label="QQ 账号" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accountList.length === 0 ? <option value="">暂无账号</option> : null}
            {accountList.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.accountId} · {account.state === 'ready' ? '档案就绪' : '待配置'}
              </option>
            ))}
          </Select>
          {instance ? <StatePill state={instance.state} /> : <span className="muted">无绑定槽位</span>}
        </div>
        <div className="toolbar-group new-conversation">
          <Select aria-label="会话类型"
            value={composeKind}
            onChange={(event) => setComposeKind(event.target.value === 'group' ? 'group' : 'private')}
          >
            <option value="private">私聊</option>
            <option value="group">群聊</option>
          </Select>
          <Input
            value={composePeer}
            onChange={(event) => setComposePeer(event.target.value)}
            placeholder="QQ / 群号"
            inputMode="numeric"
            onKeyDown={(event) => {
              if (event.key === 'Enter') openConversation();
            }}
          />
          <Button size="sm" variant="ghost" icon="plus" onClick={openConversation}>
            打开会话
          </Button>
        </div>
      </div>

      {accounts.error ? <ErrorNote message={accounts.error} /> : null}
      {error ? <ErrorNote message={error} /> : null}

      {accountList.length === 0 ? (
        <Card>
          <Empty
            icon="messages"
            title="没有可查看的会话"
            description="先启动一个槽位并完成 QQ 登录。消息按账号隔离存放在 dataRoot/accounts/<QQ>/messages 下。"
          />
        </Card>
      ) : (
        <div className="messages-layout">
          <aside className="conversation-pane">
            <div className="pane-head">
              <h3>会话</h3>
              <IconButton size={15} icon="refresh" label="刷新会话列表" onClick={() => void conversations.refresh()} />
            </div>
            {conversations.error ? <ErrorNote message={conversations.error} /> : null}
            {conversationList.length === 0 ? (
              <p className="pane-empty">还没有历史会话。右侧输入 QQ 号或群号即可打开。</p>
            ) : (
              <div className="conversation-list">
                {conversationList.map((item) => {
                  const active = activeConversation && conversationKey(activeConversation) === conversationKey(item);
                  return (
                    <ControlButton
                      type="button"
                      className={`conversation-item${active ? ' active' : ''}`}
                      key={conversationKey(item)}
                      onClick={() => setConversation(item)}
                    >
                      <span className={`conversation-avatar ${item.kind}`}>
                        {item.kind === 'group' ? '群' : '私'}
                      </span>
                      <span className="conversation-info">
                        <strong>{conversationLabel(item)}</strong>
                        <span className="muted mono">{item.peerId}</span>
                      </span>
                    </ControlButton>
                  );
                })}
              </div>
            )}
          </aside>

          <section className="thread-pane">
            {activeConversation ? (
              <>
                <header className="thread-head">
                  <div>
                    <h3>{conversationLabel(activeConversation)}</h3>
                    <span className="muted mono">
                      {accountId} · {activeConversation.kind} · {activeConversation.peerId}
                    </span>
                  </div>
                  <div className="thread-head-actions">
                    {notice ? <span className="notice-inline">{notice}</span> : null}
                    <Button size="sm" variant="ghost" icon="refresh" onClick={() => void messages.refresh()}>
                      刷新
                    </Button>
                  </div>
                </header>

                {messages.error ? <ErrorNote message={messages.error} /> : null}

                <div className="thread" ref={threadRef}>
                  {messageList.length === 0 ? (
                    <div className="thread-empty">
                      <Icon name="messages" size={26} />
                      <p>这个会话还没有落盘消息。</p>
                    </div>
                  ) : (
                    messageList.map((message) => (
                      <div
                        className={`message-row ${message.direction === 'out' ? 'is-out' : 'is-in'}`}
                        key={`${message.seq ?? message.id}`}
                      >
                        <div className="message-bubble">
                          <div className="message-meta">
                            <span>{message.direction === 'out' ? '发出' : '收到'}</span>
                            {message.senderId ? <span className="mono"> · {message.senderId}</span> : null}
                            <span> · #{message.seq ?? '-'}</span>
                            <span> · {formatTime(message.at)}</span>
                          </div>
                          <div className="message-text">
                            {message.segments.map((segment, index) => {
                              const rendered = segmentText(segment);
                              return (
                                <span className={rendered.className} key={index}>
                                  {rendered.text}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <footer className="composer">
                  {!online ? (
                    <div className="composer-hint">
                      <Icon name="warning" size={14} />
                      {instance ? '实例不在线，恢复后即可发送。' : '当前账号没有绑定运行槽位。'}
                    </div>
                  ) : null}
                  <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={online ? `发送到 ${conversationLabel(activeConversation)}…` : '实例离线'}
                    rows={3}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-actions">
                    <span className="muted">Enter 发送 · Shift+Enter 换行</span>
                    <Button
                      variant="primary"
                      icon="send"
                      busy={busy}
                      disabled={!online || !draft.trim()}
                      onClick={() => void send()}
                    >
                      发送
                    </Button>
                  </div>
                </footer>
              </>
            ) : (
              <div className="thread-placeholder">
                <Empty
                  icon="messages"
                  title="选择一个会话"
                  description="从左侧选择历史会话，或在上方输入 QQ 号 / 群号打开新会话。"
                />
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
