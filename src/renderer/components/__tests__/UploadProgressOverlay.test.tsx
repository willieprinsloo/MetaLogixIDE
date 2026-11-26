// @vitest-environment jsdom
/**
 * Contract tests for the remote-upload progress indicator (AC-D5, AC-D6): hidden without a view,
 * the exact progress copy, a polite live region, and a keyboard-reachable Cancel.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadProgressOverlay } from '../UploadProgressOverlay';
import { REMOTE_UPLOAD_COPY } from '@shared/remote-upload-contract';

afterEach(cleanup);

describe('UploadProgressOverlay', () => {
  it('renders nothing without a view', () => {
    const { container } = render(<UploadProgressOverlay view={null} onCancel={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the file name, "n of m" and the percent', () => {
    render(<UploadProgressOverlay view={{ name: 'clip.mov', index: 2, count: 3, percent: 41 }} onCancel={() => undefined} />);
    expect(screen.getByRole('status').textContent).toContain(REMOTE_UPLOAD_COPY.progressLabel('clip.mov', 2, 3, 41));
  });

  it('a single-file upload omits "n of m"', () => {
    render(<UploadProgressOverlay view={{ name: 'a.png', index: 1, count: 1, percent: 7 }} onCancel={() => undefined} />);
    expect(screen.getByRole('status').textContent).toContain('Sending a.png, 7%');
  });

  it('announces politely', () => {
    render(<UploadProgressOverlay view={{ name: 'a', index: 1, count: 1, percent: 0 }} onCancel={() => undefined} />);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  it('exposes the percent on a progressbar', () => {
    render(<UploadProgressOverlay view={{ name: 'a', index: 1, count: 1, percent: 64 }} onCancel={() => undefined} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('64');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('Cancel is a focusable button that calls onCancel', () => {
    const onCancel = vi.fn();
    render(<UploadProgressOverlay view={{ name: 'a', index: 1, count: 1, percent: 0 }} onCancel={onCancel} />);
    const button = screen.getByRole('button', { name: REMOTE_UPLOAD_COPY.cancel });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
