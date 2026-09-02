import { hexToHsva, type HsvaColor } from '@uiw/color-convert'
import Block from '@uiw/react-color-block'
import Colorful from '@uiw/react-color-colorful'
import { useEffect, useState } from 'react'
import { Button } from './button'
import { Input } from './input'

type BaseProps = {
  selectedColor: string
  colorPalette: string[]
  onUpdateColor: (color: string) => void
}

type ColorPickerProps =
  | (BaseProps & {
      clearBackgroundOption?: false
      translations: Record<'colorWheel' | 'colorPalette', string>
    })
  | (BaseProps & {
      clearBackgroundOption: true
      translations: Record<'colorWheel' | 'colorPalette' | 'clearBackground', string>
    })

const TRANSPARENT_HSVA: HsvaColor = { h: 0, s: 0, v: 0, a: 0 }

/** Prefix a `#` when the user typed a bare hex value; keep anything else as typed. */
export function normalizeHexDraft(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (/^[0-9A-Fa-f]/.test(trimmed[0])) return `#${trimmed}`
  return trimmed
}

/** Only complete `#RGB` / `#RRGGBB` values are committed to the caller. */
export function isCompleteHexColor(value: string): boolean {
  return /^#[0-9A-Fa-f]{3}$/.test(value) || /^#[0-9A-Fa-f]{6}$/.test(value)
}

/** Black or white, whichever reads better on `color` (a `#RRGGBB` or `transparent`). */
export function getContrastingTextColor(color: string): '#000000' | '#ffffff' {
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return '#ffffff'
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b
  return luminance > 186 ? '#000000' : '#ffffff'
}

/**
 * Colour wheel (HSVA) + swatch palette + validated hex input, ported from
 * upstream (7e563166 … c3faca19). `transparent` is represented to the wheel
 * as an alpha-0 HSVA sentinel so the widgets never receive an invalid hex.
 */
export default function ColorPicker(props: ColorPickerProps) {
  const { selectedColor, colorPalette, translations, onUpdateColor } = props
  const [colorMode, setColorMode] = useState<'wheel' | 'palette'>('wheel')
  const [hexInput, setHexInput] = useState(selectedColor)
  const [transparentColorHSVA, setTransparentColorHSVA] = useState<HsvaColor>(TRANSPARENT_HSVA)

  useEffect(() => {
    setHexInput(selectedColor)
  }, [selectedColor])

  const handleColorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const normalized = normalizeHexDraft(e.target.value)
    setHexInput(normalized)
    if (isCompleteHexColor(normalized)) {
      onUpdateColor(normalized)
    }
  }

  const widgetColor = selectedColor !== 'transparent' ? selectedColor : transparentColorHSVA

  return (
    <div className="p-1 flex flex-col gap-4 items-center">
      <div className="flex items-center gap-2 w-full">
        <Button
          variant="outline"
          size="sm"
          className="w-full h-9 justify-start gap-2 bg-white/5 border-white/10 hover:bg-white/10 px-2"
          onClick={() => setColorMode('wheel')}
          aria-pressed={colorMode === 'wheel'}
          style={{ backgroundColor: colorMode === 'wheel' ? '#34B27B' : 'transparent' }}
        >
          <span className="text-xs text-slate-300 truncate flex-1 text-left">
            {translations.colorWheel}
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-full h-9 justify-start gap-2 bg-white/5 border-white/10 hover:bg-white/10 px-2"
          onClick={() => setColorMode('palette')}
          aria-pressed={colorMode === 'palette'}
          style={{ backgroundColor: colorMode === 'palette' ? '#34B27B' : 'transparent' }}
        >
          <span className="text-xs text-slate-300 truncate flex-1 text-left">
            {translations.colorPalette}
          </span>
        </Button>
      </div>
      {colorMode === 'wheel' && (
        <>
          <div
            className="w-full h-20 flex items-center justify-center border border-white/10 rounded-lg relative overflow-hidden"
            data-testid="color-preview"
          >
            {selectedColor === 'transparent' && (
              <div className="absolute inset-0 checkerboard-bg opacity-50" />
            )}
            <div className="absolute inset-0" style={{ backgroundColor: selectedColor }} />
            <span
              className="relative text-xs"
              style={{ color: getContrastingTextColor(selectedColor) }}
            >
              {selectedColor}
            </span>
          </div>
          <Colorful
            color={widgetColor}
            onChange={(color) => onUpdateColor(color.hex)}
            style={{ borderRadius: '8px' }}
            disableAlpha={true}
          />
          <Input
            type="text"
            value={hexInput}
            aria-label="Hex color"
            spellCheck={false}
            className="w-full h-9 rounded-md border border-white/10 bg-white/5 px-2 text-xs text-slate-200 outline-none focus:border-[#34B27B]/50 focus:ring-1 focus:ring-[#34B27B]/30"
            onChange={handleColorInputChange}
          />
        </>
      )}
      {colorMode === 'palette' && (
        <Block
          color={widgetColor}
          colors={colorPalette}
          onChange={(color) => onUpdateColor(color.hex)}
          style={{ width: '100%', borderRadius: '8px' }}
        />
      )}
      {props.clearBackgroundOption === true && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full mt-2 text-xs h-7 hover:bg-white/5 text-slate-400"
          onClick={() => {
            if (selectedColor !== 'transparent' && isCompleteHexColor(selectedColor)) {
              setTransparentColorHSVA({ ...hexToHsva(selectedColor), a: 0 })
            }
            onUpdateColor('transparent')
          }}
        >
          {props.translations.clearBackground}
        </Button>
      )}
    </div>
  )
}
