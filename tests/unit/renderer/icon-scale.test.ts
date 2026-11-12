/**
 * Fixture tests for the icon scale check (AC2a, AC10). Each rule must fire on
 * its own bad fixture and stay quiet on a clean one; the tree-wide run lives
 * in icon-scale-tree.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { iconScaleViolations } from '../../support/icon-scale';

const FILE = 'src/renderer/components/Fixture.tsx';

function rules(source: string, path = FILE): string[] {
  return iconScaleViolations(path, source).map((v) => v.split(' ')[1] ?? '');
}

const CLEAN = `
import { ICON_SIZE, ICON_STROKE, type IconSize } from './icon-size';
export function A() {
  return <svg width={ICON_SIZE.md} height={ICON_SIZE.md} strokeWidth={ICON_STROKE.outline} viewBox="0 0 24 24" />;
}
export function B({ size = ICON_SIZE.sm }: { readonly size?: IconSize }) {
  return (
    <svg
      width={size}
      height={size}
      strokeWidth="2"
    ><path strokeWidth={2} d="M0 0" /></svg>
  );
}
export function C() {
  return <svg width={ICON_SIZE.xs} height={ICON_SIZE.xs} strokeWidth="2.5" />;
}
export function D() { return <XIcon size={ICON_SIZE.sm} />; }
`;

describe('iconScaleViolations', () => {
  it('passes a clean file', () => {
    expect(iconScaleViolations(FILE, CLEAN)).toEqual([]);
  });

  it('R1: flags a numeric-literal width/height, in quotes or braces, with its line', () => {
    const quoted = iconScaleViolations(FILE, '\n<svg width="13" height="13" />');
    expect(quoted).toHaveLength(1);
    expect(quoted[0]).toMatch(/^2 R1 /);
    expect(rules('<svg width={13} height={13} />')).toEqual(['R1']);
  });

  it('R1: flags a missing height and a width that differs from height', () => {
    expect(rules('<svg width={ICON_SIZE.md} />')).toEqual(['R1']);
    expect(rules('<svg width={ICON_SIZE.md} height={ICON_SIZE.sm} />')).toEqual(['R1']);
  });

  it('R2: flags a bare size identifier whose prop is not typed IconSize', () => {
    const src = 'export function S({ size = 14 }: { readonly size?: number }) { return <svg width={size} height={size} />; }';
    expect(rules(src)).toEqual(['R2']);
  });

  it('R2: checks the typing in the svg own component, not elsewhere in the file', () => {
    const src = [
      'export function A({ size = ICON_SIZE.xs }: { readonly size?: IconSize }) { return <svg width={size} height={size} />; }',
      'export function B({ size = 14 }: { readonly size?: number }) { return <svg width={size} height={size} />; }',
    ].join('\n');
    const found = iconScaleViolations(FILE, src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^2 R2 /);
  });

  it('R3: flags an icon component given a numeric size', () => {
    expect(rules('<SplitIcon size={13} />')).toEqual(['R3']);
    expect(rules('<CheckIcon size={ 14 } />')).toEqual(['R3']);
  });

  it('R4: flags an off-rule literal stroke width', () => {
    expect(rules('<svg width={ICON_SIZE.md} height={ICON_SIZE.md} strokeWidth="1.9" />')).toEqual(['R4']);
    expect(rules('<svg width={ICON_SIZE.md} height={ICON_SIZE.md}><path strokeWidth={2.4} /></svg>')).toEqual(['R4']);
  });

  it('R4: allows 2.5 only in an xs svg', () => {
    expect(rules('<svg width={ICON_SIZE.md} height={ICON_SIZE.md} strokeWidth="2.5" />')).toEqual(['R4']);
    expect(rules('<svg width={ICON_SIZE.md} height={ICON_SIZE.md} strokeWidth={ICON_STROKE.xs} />')).toEqual(['R4']);
  });

  it('R4: requires 2.5 in an xs svg; a literal 2 or ICON_STROKE.outline there is flagged', () => {
    expect(rules('<svg width={ICON_SIZE.xs} height={ICON_SIZE.xs} strokeWidth="2" />')).toEqual(['R4']);
    expect(rules('<svg width={ICON_SIZE.xs} height={ICON_SIZE.xs} strokeWidth={ICON_STROKE.outline} />')).toEqual(['R4']);
    expect(rules('<svg width={ICON_SIZE.xs} height={ICON_SIZE.xs} strokeWidth={ICON_STROKE.xs} />')).toEqual([]);
  });

  it('R4: allows 3 only in components/CheckIcon.tsx', () => {
    const src = '<svg width={size} height={size} strokeWidth={3} />';
    const typed = `function CheckIcon({ size }: { readonly size: IconSize }) { return ${src}; }`;
    expect(rules(typed)).toEqual(['R4']);
    expect(rules(typed, 'src/renderer/components/CheckIcon.tsx')).toEqual([]);
  });

  it('R4: allows the named exceptions only in their own file and component', () => {
    const star = 'export function StarFilledIcon() { return <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} strokeWidth="1.5" />; }';
    expect(rules(star, 'src/renderer/components/shell-icons.tsx')).toEqual([]);
    expect(rules(star, FILE)).toEqual(['R4']);
    const other = 'export function StarIcon() { return <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} strokeWidth="1.5" />; }';
    expect(rules(other, 'src/renderer/components/shell-icons.tsx')).toEqual(['R4']);
    const glyph = 'function RootFolderGlyph() { return <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} strokeWidth="1.8" />; }';
    expect(rules(glyph, 'src/renderer/components/RootFolderGlyph.tsx')).toEqual([]);
  });
});
