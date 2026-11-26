import { describe, test, expect } from 'vitest';
import { errMessage } from '../err-message';

describe('errMessage', () => {
  test('stringifies a non-Error value', () => {
    expect(errMessage('plain failure')).toBe('plain failure');
  });
  test('strips the Electron invoke wrapper and the RpcError label', () => {
    const e = new Error("Error invoking remote method 'p2p:rpc-call': RpcError: host offline");
    expect(errMessage(e)).toBe('host offline');
  });
  test('strips a plain Error: label', () => {
    expect(errMessage(new Error('Error: boom'))).toBe('boom');
  });
  test('leaves a message with no prefix untouched', () => {
    expect(errMessage(new Error('no prefix here'))).toBe('no prefix here');
  });
});
