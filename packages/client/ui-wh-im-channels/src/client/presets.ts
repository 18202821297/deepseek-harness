/** Shipped agent preset ids and their locale keys (descriptions live in locales.ts). */
export const PRESET_IDS = ['standard', 'code', 'minimal', 'cordis'] as const

export type PresetId = typeof PRESET_IDS[number]

export interface PresetOption {
  id: PresetId
  nameKey: string
  descriptionKey: string
}

export const PRESET_OPTIONS: PresetOption[] = PRESET_IDS.map(id => ({
  id,
  nameKey: `preset.${id}.name`,
  descriptionKey: `preset.${id}.description`,
}))
