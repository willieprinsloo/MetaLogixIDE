/**
 * Recognises PTY input that answers a blocking Claude prompt (spec AC7, plan
 * Q1): input containing Enter, a lone Esc, Ctrl-C, or a single digit 1-9.
 * Terminal-generated reports (focus, DA, CPR) and navigation keys are
 * escape sequences longer than one byte, so they never count.
 */

const LONE_ANSWER = /^(?:\x1b|\x03|[1-9])$/;

/** True when `data`, one chunk written to a shell's PTY, answers a blocking prompt. */
export function isAnsweringInput(data: string): boolean {
  return data.includes('\r') || LONE_ANSWER.test(data);
}
