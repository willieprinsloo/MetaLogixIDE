/** Group-chat types shared by the main process and the renderer (no Node or DOM imports). */

/** Whether a headless engine can run right now, and if not, why and how to fix it. */
export type EngineStatus =
  | { ready: true; version?: string; models?: string[] }
  | { ready: false; why: string; version?: string };

export type HeadlessEngine = 'codex' | 'gemini' | 'ollama';
export type MemberEngine = 'claude' | HeadlessEngine;

export type MemberId = string;
export type LogKind = 'start' | 'you' | 'reply' | 'fail' | 'round' | 'member' | 'end';
export interface LogEntry { at: string; kind: LogKind; from?: MemberId; text: string; round?: number }
export interface Answer { text?: string; pass?: boolean; failed?: string }

/** A group chat as the round state machine (src/main/group-chat/groups.ts) keeps it. */
export interface Group {
  id: string;
  projectId: number;
  projectName: string;
  name: string;
  members: MemberId[];
  maxRounds: number;
  status: 'idle' | 'running' | 'stopped';
  round: { n: number; waiting: MemberId[]; answers: Record<MemberId, Answer> } | null;
  /** Round number within the current conversation (1..maxRounds). */
  k: number;
  /** Group-unique round id, so late answers to an old round are ignored. */
  seq: number;
  /** The user's messages waiting for the next round. */
  held: string[];
  /** Members who joined mid-conversation; their first message carries the story so far. */
  joined: MemberId[];
  log: LogEntry[];
  createdAt: string;
  updatedAt: string;
}

/** Where a member's current turn is, for the status line. */
export type TurnPhase = 'queued' | 'waiting-idle' | 'waiting-draft' | 'running';

export interface MemberInfo {
  name: string;
  kind: 'claude-tab' | 'headless';
  engine: MemberEngine;
  model: string | null;
  /** False for a Claude member whose conversation isn't open in any tab of the project. */
  available: boolean;
  /** This member's turn in this group, or null when it has none. */
  phase: TurnPhase | null;
}

/** What the group panel gets: the group plus a description of each member. */
export interface GroupView extends Group {
  memberInfo: Record<MemberId, MemberInfo>;
}

export const ENGINE_LABEL: Readonly<Record<MemberEngine, string>> = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini', ollama: 'Ollama' };
