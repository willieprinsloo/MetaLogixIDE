import type { ChangeEvent } from 'react';
import { FROSTED_GLASS_COPY, FROSTED_GLASS_TESTIDS } from '@renderer/frosted-chrome-contract';
import { VIBRANCY_MATERIALS, isVibrancyMaterial, type VibrancyMaterial } from '@shared/frosted-glass';

export interface MaterialRowProps {
  value: VibrancyMaterial;
  onChange: (material: VibrancyMaterial) => void;
}

const SELECT_CLASS =
  'h-[34px] rounded-[9px] bg-[--surface-field] px-2.5 text-[13px] text-[--text] focus:outline-none focus:ring-2 focus:ring-[--accent]/60 focus-visible:rounded-[9px]';

/**
 * The Frosted glass "Material" row: a labelled native select over every approved vibrancy
 * material (D7), with its hint. Only a value inside `VIBRANCY_MATERIALS` reaches `onChange`;
 * anything else from the DOM is dropped rather than cast.
 */
export function MaterialRow({ value, onChange }: MaterialRowProps) {
  const id = `${FROSTED_GLASS_TESTIDS.material}-label`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col">
        <label htmlFor={id} className="text-[13px] font-medium text-[--text]">{FROSTED_GLASS_COPY.material}</label>
        <span className="text-xs text-[--text-muted]">{FROSTED_GLASS_COPY.materialHint}</span>
      </div>
      <select
        id={id}
        data-testid={FROSTED_GLASS_TESTIDS.material}
        value={value}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => { if (isVibrancyMaterial(e.target.value)) onChange(e.target.value); }}
        className={SELECT_CLASS}
      >
        {VIBRANCY_MATERIALS.map((material) => (
          <option key={material} value={material}>{FROSTED_GLASS_COPY.materials[material]}</option>
        ))}
      </select>
    </div>
  );
}
