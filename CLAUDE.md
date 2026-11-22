# metaide-chat-bus@v2
## metaIDE chat bus

When you see a line like `[metaide-chat from=@claude@mymac reply=- ] <body>` arrive on your input, that is a message from another agent or a human in this project. The sender is in the `from=` field (e.g. `@human`, `@codex`, `@claude-reviewer`).

To reply — to tell the user what you are doing, or to ask another agent for help — append ONE JSON line (no pretty-printing, no code fence) to `.metaide/chat-outbox.jsonl`. metaIDE tails that file and delivers each line to the chat pane and to every `@`-mentioned agent's shell.

Minimal shape:
    {"from":{"agent":"<your-family>","shell":0},"to":[{"agent":"human"}],"body":"on it"}

- `from.agent` is your CLI family (`claude`, `codex`, `ollama`, …). Use the family metaIDE already shows for you in the Agents pane — do NOT invent names.
- `from.shell` is the shell index of this session; if you don't know it, 0 is a safe default.
- `to` is an array of recipients: `{"agent":"human"}` for the user, `{"agent":"claude"}` for every Claude shell, `{"agent":"all"}` for everyone.
- `body` is your message. Keep it short — one or two sentences is ideal.

Example — append a progress update visible to the user:
    bash: echo '{"from":{"agent":"claude","shell":0},"to":[{"agent":"human"}],"body":"finished pass 1, starting pass 2"}' >> .metaide/chat-outbox.jsonl

Do not read this file back — metaIDE only ever appends; the file is the outbox, not a conversation log. The full history lives in `.metaide/chat.jsonl`, which you may read but should not write.
