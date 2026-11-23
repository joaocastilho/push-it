import { For } from 'solid-js';

interface DigitCodeInputProps {
  value: string;
  onChange: (next: string) => void;
  onComplete?: (code: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

const SLOTS = [0, 1, 2, 3, 4, 5] as const;

export function DigitCodeInput(props: DigitCodeInputProps) {
  const inputs: Array<HTMLInputElement | undefined> = [];

  function cleanDigits(raw: string): string {
    return raw.replace(/\D/g, '').slice(0, 6);
  }

  function updateValue(next: string) {
    const clean = cleanDigits(next);
    props.onChange(clean);
    if (clean.length === 6) {
      props.onComplete?.(clean);
    }
  }

  function handleInput(index: number, raw: string) {
    const digits = raw.replace(/\D/g, '');
    if (!digits) {
      const chars = props.value.padEnd(6, ' ').split('');
      chars[index] = ' ';
      const next = chars.join('').replace(/\s+/g, '');
      updateValue(next);
      return;
    }

    // Handle pasting or autofilling multiple digits into one box
    if (digits.length > 1) {
      const merged = (props.value.slice(0, index) + digits).slice(0, 6);
      updateValue(merged);
      const focusIdx = Math.min(merged.length, 5);
      inputs[focusIdx]?.focus();
      return;
    }

    const chars = Array.from({ length: 6 }, (_, i) => props.value[i] || '');
    chars[index] = digits[0];
    const next = chars.join('').slice(0, 6);
    updateValue(next);
    if (index < 5) {
      inputs[index + 1]?.focus();
    }
  }

  function handleKeyDown(index: number, e: KeyboardEvent) {
    if (e.key === 'Backspace') {
      if (!props.value[index] && index > 0) {
        e.preventDefault();
        const next = props.value.slice(0, index - 1) + props.value.slice(index);
        updateValue(next);
        inputs[index - 1]?.focus();
      } else if (props.value[index]) {
        e.preventDefault();
        const next = props.value.slice(0, index) + props.value.slice(index + 1);
        updateValue(next);
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      inputs[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      e.preventDefault();
      inputs[index + 1]?.focus();
    }
  }

  function handlePaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text') || '';
    const digits = cleanDigits(text);
    if (digits) {
      e.preventDefault();
      updateValue(digits);
      inputs[Math.min(digits.length, 5)]?.focus();
    }
  }

  return (
    <div class="digit-code-group" role="group" aria-label={props.ariaLabel || '6-digit code'}>
      <For each={SLOTS}>
        {(idx) => (
          <>
            {idx === 3 ? <span class="digit-sep" aria-hidden="true">–</span> : null}
            <input
              ref={(el) => {
                inputs[idx] = el;
              }}
              class="digit-box"
              type="text"
              inputmode="numeric"
              autocomplete={idx === 0 ? 'one-time-code' : 'off'}
              pattern="[0-9]*"
              maxlength={6}
              disabled={props.disabled}
              value={props.value[idx] || ''}
              aria-label={`Digit ${idx + 1}`}
              onInput={(e) => handleInput(idx, e.currentTarget.value)}
              onKeyDown={(e) => handleKeyDown(idx, e)}
              onPaste={handlePaste}
              onFocus={(e) => e.currentTarget.select()}
            />
          </>
        )}
      </For>
    </div>
  );
}
