// @vitest-environment jsdom
//
// Smoke test for the DOM test harness: proves that the per-file
// `@vitest-environment jsdom` opt-in works on top of the `node` default in
// vitest.config.ts, and that @testing-library/react, jest-dom matchers and
// user-event are wired up.
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

function Counter() {
  const [count, setCount] = useState(0)
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      clicked {count}
    </button>
  )
}

describe('jsdom test harness', () => {
  it('runs in a DOM environment', () => {
    expect(typeof document).toBe('object')
    expect(typeof window).toBe('object')
  })

  it('renders a component and responds to user events', async () => {
    const user = userEvent.setup()
    render(<Counter />)

    const button = screen.getByRole('button', { name: 'clicked 0' })
    expect(button).toBeInTheDocument()

    await user.click(button)
    expect(screen.getByRole('button')).toHaveTextContent('clicked 1')
  })
})
