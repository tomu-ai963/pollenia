// trait-spec.js の型（Worker の TypeScript から読むため）。
export type Genre = 'rose' | 'hellebore' | 'succulent' | 'vegetable' | 'other';
export interface TraitOption {
  value: string;
  label: string;
}
export interface TraitSpec {
  key: string;
  label: string;
  type: 'enum' | 'int' | 'number' | 'text';
  values?: TraitOption[];
  min?: number;
  max?: number;
  unit?: string;
  genres: Genre[];
}
export const GENRES: { value: Genre; label: string }[];
export const TRAITS: TraitSpec[];
export const TRAIT_BY_KEY: Map<string, TraitSpec>;
export function traitsForGenre(genre: string | null | undefined): TraitSpec[];
export function genreLabel(genre: string | null | undefined): string | null;
export function validateTrait(
  spec: TraitSpec,
  v: unknown,
): { ok: true; value: string | number | null } | { ok: false; message: string };
export function formatTraitValue(spec: TraitSpec, v: unknown): string;
export function traitEntries(traits: unknown): { key: string; label: string; text: string }[];
