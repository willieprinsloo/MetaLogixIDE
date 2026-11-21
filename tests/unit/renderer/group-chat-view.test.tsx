/** The group panel's markup: members, status and Stop, transcript, and model output kept as text. */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GroupView, MemberInfo } from '@shared/group-chat';

vi.mock('@renderer/api', () => ({ api: {} }));
const { GroupChatView } = await import('@renderer/components/GroupChatView');

const info = (name: string, engine: MemberInfo['engine'], over: Partial<MemberInfo> = {}): MemberInfo =>
  ({ name, kind: engine === 'claude' ? 'claude-tab' : 'headless', engine, model: null, available: true, phase: null, ...over });
const G = (over: Partial<GroupView> = {}): GroupView => ({
  id: 'g1', projectId: 1, projectName: 'shop', name: 'Group chat 1', members: ['boss', 'gpt'], maxRounds: 4,
  status: 'idle', round: null, k: 0, seq: 0, held: [], joined: [], log: [], createdAt: '', updatedAt: '',
  memberInfo: { boss: info('Main (Claude)', 'claude'), gpt: info('Review (GPT)', 'codex') },
  ...over,
});
const noop = () => {};
const render = (group: GroupView | null, groups: GroupView[] = group ? [group] : []) => renderToStaticMarkup(
  <GroupChatView
    groups={groups} group={group} draft="" error={null}
    onPick={noop} onNew={noop} onRemoveMember={noop} onOpenAdd={noop} onStop={noop} onDelete={noop}
    onRounds={noop} onDraft={noop} onSend={noop}
  />,
);

describe('GroupChatView', () => {
  it('shows each member with its engine badge and a remove button', () => {
    const html = render(G());
    expect(html).toContain('Main (Claude)');
    expect(html).toContain('Review (GPT)');
    expect(html).toMatch(/data-testid="group-member-chip"[\s\S]*Claude/);
    expect(html.match(/data-testid="group-remove-member"/g)).toHaveLength(2);
  });

  it('marks a Claude member whose tab isn’t open', () => {
    const html = render(G({ memberInfo: { boss: info('Main (Claude)', 'claude', { available: false }), gpt: info('Review (GPT)', 'codex') } }));
    expect(html).toContain('its Claude tab isn’t open');
  });

  it('shows Stop only while running', () => {
    expect(render(G())).not.toContain('data-testid="group-stop"');
    expect(render(G({ status: 'running', k: 1, round: { n: 1, waiting: ['gpt'], answers: {} } }))).toContain('data-testid="group-stop"');
  });

  it('shows the status line and round dividers', () => {
    const html = render(G({ log: [{ at: '', kind: 'start', text: 'go' }, { at: '', kind: 'round', text: 'Round 1 of 4', round: 1 }] }));
    expect(html).toContain('Ready');
    expect(html).toContain('data-testid="group-round-divider"');
  });

  it('renders model output as text, not HTML', () => {
    const html = render(G({ log: [{ at: '', kind: 'reply', from: 'gpt', text: '<img src=x onerror=alert(1)> **bold**' }] }));
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('<strong>bold</strong>');
  });

  it('with no group yet it offers to start one', () => {
    expect(render(null)).toContain('data-testid="group-new"');
  });
});
