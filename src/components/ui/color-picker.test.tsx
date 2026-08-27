// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ColorPicker, { getContrastingTextColor, isCompleteHexColor, normalizeHexDraft } from './color-picker';

const translations = { colorWheel: 'Wheel', colorPalette: 'Palette', clearBackground: 'Clear' };
const palette = ['#FF0000', '#00FF00', '#0000FF'];

describe('normalizeHexDraft', () => {
  it('prefixes a # for bare hex input and trims whitespace', () => {
    expect(normalizeHexDraft('ff00aa')).toBe('#ff00aa');
    expect(normalizeHexDraft('  #ff00aa ')).toBe('#ff00aa');
    expect(normalizeHexDraft('')).toBe('');
    expect(normalizeHexDraft('transparent')).toBe('transparent');
  });
});

describe('isCompleteHexColor', () => {
  it('accepts only #RGB and #RRGGBB', () => {
    expect(isCompleteHexColor('#abc')).toBe(true);
    expect(isCompleteHexColor('#AABBCC')).toBe(true);
    expect(isCompleteHexColor('#ab')).toBe(false);
    expect(isCompleteHexColor('#abcd')).toBe(false);
    expect(isCompleteHexColor('#abcdef0')).toBe(false);
    expect(isCompleteHexColor('abcdef')).toBe(false);
    expect(isCompleteHexColor('#ggg')).toBe(false);
  });
});

describe('getContrastingTextColor', () => {
  it('uses dark text on light colours and light text otherwise', () => {
    expect(getContrastingTextColor('#ffffff')).toBe('#000000');
    expect(getContrastingTextColor('#000000')).toBe('#ffffff');
    expect(getContrastingTextColor('transparent')).toBe('#ffffff');
  });
});

describe('ColorPicker', () => {
  it('commits only complete hex values typed into the input', () => {
    const onUpdateColor = vi.fn();
    render(
      <ColorPicker selectedColor="#ffffff" colorPalette={palette} onUpdateColor={onUpdateColor} translations={translations} />,
    );
    const input = screen.getByLabelText('Hex color') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '#12' } });
    expect(onUpdateColor).not.toHaveBeenCalled();
    expect(input.value).toBe('#12');

    fireEvent.change(input, { target: { value: '123456' } });
    expect(onUpdateColor).toHaveBeenCalledWith('#123456');
    expect(input.value).toBe('#123456');
  });

  it('switches between wheel and palette modes', async () => {
    const user = userEvent.setup();
    render(
      <ColorPicker selectedColor="#ffffff" colorPalette={palette} onUpdateColor={() => undefined} translations={translations} />,
    );
    expect(screen.getByLabelText('Hex color')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Palette' }));
    expect(screen.queryByLabelText('Hex color')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Wheel' }));
    expect(screen.getByLabelText('Hex color')).toBeInTheDocument();
  });

  it('offers a clear button only when clearBackgroundOption is set and reports transparent', async () => {
    const user = userEvent.setup();
    const onUpdateColor = vi.fn();
    const { rerender } = render(
      <ColorPicker selectedColor="#ff0000" colorPalette={palette} onUpdateColor={onUpdateColor} translations={translations} />,
    );
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();

    rerender(
      <ColorPicker
        selectedColor="#ff0000"
        colorPalette={palette}
        onUpdateColor={onUpdateColor}
        clearBackgroundOption
        translations={translations}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onUpdateColor).toHaveBeenCalledWith('transparent');
  });

  it('renders a transparent selection without crashing the wheel', () => {
    render(
      <ColorPicker
        selectedColor="transparent"
        colorPalette={palette}
        onUpdateColor={() => undefined}
        clearBackgroundOption
        translations={translations}
      />,
    );
    expect(screen.getByTestId('color-preview')).toHaveTextContent('transparent');
  });
});
