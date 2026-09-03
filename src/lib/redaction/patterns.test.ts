import { describe, expect, it } from 'vitest'
import {
  findSecrets,
  hasSecret,
  maskSecrets,
  type SecretKind,
  SECRET_KINDS,
  shannonEntropy,
} from './patterns'

/** Assembled at runtime so the corpus never contains a scanner-shaped secret literal. */
const secret = (prefix: string, body: string): string => prefix + body

/**
 * The corpus is the specification. Everything else in `patterns.ts` — the
 * digest-length exemption, the placeholder list, the entropy floor — exists
 * because of a line below, so a regex tweak that "looks harmless" has to
 * survive both halves of the table before it lands.
 *
 * Positives assert the *kind* as well as the span: reporting a JWT as a
 * base64 token would still blur the right pixels, but it would put the wrong
 * words in the UI and it means the specific detector silently stopped firing.
 */

interface Positive {
  readonly text: string
  readonly kind: SecretKind
  /** The substring that must be covered by the match. */
  readonly value: string
}

const POSITIVES: readonly Positive[] = [
  // --- email -------------------------------------------------------------
  {
    text: 'Contact ada.lovelace@example.com for access',
    kind: 'email',
    value: 'ada.lovelace@example.com',
  },
  {
    text: 'From: noreply+alerts@corp.internal.example.org',
    kind: 'email',
    value: 'noreply+alerts@corp.internal.example.org',
  },
  { text: 'billing@example.io', kind: 'email', value: 'billing@example.io' },
  {
    text: 'owner j.o-brien@mail.example.co.uk approved',
    kind: 'email',
    value: 'j.o-brien@mail.example.co.uk',
  },
  {
    text: 'signup with test.user_1@sub-domain.example.com',
    kind: 'email',
    value: 'test.user_1@sub-domain.example.com',
  },

  // --- phone -------------------------------------------------------------
  { text: 'Mobile +1 (415) 555-0132', kind: 'phone', value: '+1 (415) 555-0132' },
  { text: 'Call 415-555-0132 now', kind: 'phone', value: '415-555-0132' },
  { text: 'fax 415.555.0132', kind: 'phone', value: '415.555.0132' },
  { text: 'London office +44 20 7946 0958', kind: 'phone', value: '+44 20 7946 0958' },
  { text: 'Reception 020 7946 0958', kind: 'phone', value: '020 7946 0958' },
  { text: 'Hotline +84 912 345 678', kind: 'phone', value: '+84 912 345 678' },
  { text: 'Desk (415) 555-0132 ext 4', kind: 'phone', value: '(415) 555-0132' },

  // --- self-identifying credentials --------------------------------------
  {
    text: 'OPENAI_KEY ' + secret('sk-', 'live-9TQ4vn2XbLm7Zr5Kd8Hs1Wf'),
    kind: 'openai-key',
    value: secret('sk-', 'live-9TQ4vn2XbLm7Zr5Kd8Hs1Wf'),
  },
  {
    text: secret('sk-', 'proj-abcdefghijklmnopqrstuvwx'),
    kind: 'openai-key',
    value: secret('sk-', 'proj-abcdefghijklmnopqrstuvwx'),
  },
  {
    text: 'anthropic ' + secret('sk-', 'ant-api03-Xy7Zt4Qv9Lm2Rk8Nb3Wp6Hs1Ad5Fg0'),
    kind: 'openai-key',
    value: secret('sk-', 'ant-api03-Xy7Zt4Qv9Lm2Rk8Nb3Wp6Hs1Ad5Fg0'),
  },
  {
    text: 'aws_access_key_id ' + secret('AKIA', 'IOSFODNN7EXAMPLE'),
    kind: 'aws-access-key',
    value: secret('AKIA', 'IOSFODNN7EXAMPLE'),
  },
  { text: 'ASIAY34FZKBOKMUTVV7A', kind: 'aws-access-key', value: 'ASIAY34FZKBOKMUTVV7A' },
  {
    text: 'git remote token ' + secret('ghp_', '16C7e42F292c6912E7710c838347Ae178B4a'),
    kind: 'github-token',
    value: secret('ghp_', '16C7e42F292c6912E7710c838347Ae178B4a'),
  },
  {
    text: secret('github_pat_', '11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP'),
    kind: 'github-token',
    value: secret('github_pat_', '11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP'),
  },
  {
    text:
      '//registry.npmjs.org/:_authToken=' + secret('npm_', 'zN0hFTgVUJeGyKmc4Kx2Qw1lE5rT7yU3iO9p'),
    kind: 'npm-token',
    value: secret('npm_', 'zN0hFTgVUJeGyKmc4Kx2Qw1lE5rT7yU3iO9p'),
  },
  {
    text:
      'Cookie: jwt=' +
      secret(
        'eyJ',
        'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
          'eyJ' +
          'zdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      ),
    kind: 'jwt',
    value: secret(
      'eyJ',
      'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJ' +
        'zdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ),
  },
  {
    text: 'slack ' + secret('xoxb-', '2417839201-4185729301-Xa9Kd2Lm7Pq3Rz8Tn1Vb6Yc'),
    kind: 'slack-token',
    value: secret('xoxb-', '2417839201-4185729301-Xa9Kd2Lm7Pq3Rz8Tn1Vb6Yc'),
  },
  {
    text: 'maps key ' + secret('AIza', 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'),
    kind: 'google-api-key',
    value: secret('AIza', 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'),
  },
  {
    text: 'stripe ' + secret('sk_live_', '51H8xQ2LkdIwHu7ix0kMz9Y3a'),
    kind: 'stripe-key',
    value: secret('sk_live_', '51H8xQ2LkdIwHu7ix0kMz9Y3a'),
  },
  {
    text: secret('pk_test_', 'TYooMQauvdEDq54NiTphI7jx'),
    kind: 'stripe-key',
    value: secret('pk_test_', 'TYooMQauvdEDq54NiTphI7jx'),
  },
  {
    text: '-----BEGIN RSA PRIVATE KEY-----',
    kind: 'private-key-block',
    value: '-----BEGIN RSA PRIVATE KEY-----',
  },
  {
    text: '-----BEGIN OPENSSH PRIVATE KEY-----',
    kind: 'private-key-block',
    value: '-----BEGIN OPENSSH PRIVATE KEY-----',
  },

  // --- labelled ----------------------------------------------------------
  {
    text: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    kind: 'labelled-secret',
    value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  {
    text: 'password: Tr0ub4dor3-horse-staple',
    kind: 'labelled-secret',
    value: 'Tr0ub4dor3-horse-staple',
  },
  {
    text: 'client_secret: 5f4dcc3b5aa765d61d8327deb882cf99abc',
    kind: 'labelled-secret',
    value: '5f4dcc3b5aa765d61d8327deb882cf99abc',
  },
  {
    text: 'Authorization: Bearer 9f8c2b1a7e6d5c4b3a2f1e0d9c8b7a6f',
    kind: 'labelled-secret',
    value: '9f8c2b1a7e6d5c4b3a2f1e0d9c8b7a6f',
  },
  {
    text: 'session_token=abcd1234efgh5678ijklMNOP',
    kind: 'labelled-secret',
    value: 'abcd1234efgh5678ijklMNOP',
  },
  {
    text: 'api_key = "Rk9PQkFSMTIzNDU2Nzg5MEFC"',
    kind: 'labelled-secret',
    value: 'Rk9PQkFSMTIzNDU2Nzg5MEFC',
  },
  {
    text: 'PGPASSWORD=s3cr3t-p0stgres-pw psql',
    kind: 'labelled-secret',
    value: 's3cr3t-p0stgres-pw',
  },
  {
    text: 'Authorization: Basic dXNlcjpzdXBlcnNlY3JldA==',
    kind: 'labelled-secret',
    value: 'dXNlcjpzdXBlcnNlY3JldA==',
  },

  // --- generic high-entropy ----------------------------------------------
  {
    text: 'token a3f5c9d1e7b2486fa0c3d5e8b1729406fd83ac51be27d094 issued',
    kind: 'hex-token',
    value: 'a3f5c9d1e7b2486fa0c3d5e8b1729406fd83ac51be27d094',
  },
  {
    text: 'X-Request-Auth xQ7pL2mV9bN4zR8tY1wC6eK3jH5gF0dS7aP2',
    kind: 'base64-token',
    value: 'xQ7pL2mV9bN4zR8tY1wC6eK3jH5gF0dS7aP2',
  },
  {
    text: 'refresh Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1A',
    kind: 'base64-token',
    value: 'Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1A',
  },
]

/**
 * Everything here appears routinely on a developer's or an admin's screen and
 * must never produce a blur region. The hard cases are the ones that are
 * structurally identical to a secret — a git SHA *is* a 40-character hex run —
 * and are separated only by a rule that is easy to delete by accident.
 */
const NEGATIVES: readonly string[] = [
  // version and build strings
  'Version 1.2.3 released',
  'capturia v1.10.234',
  'Windows 10.0.19045.3803',
  'npm install lodash@4.17.21',
  'import Dialog from "@radix-ui/react-dialog"',
  'Build 20260903.4',
  'node --version -> v22.20.1',
  // digests and ids
  'commit e9a1b3c4d5f60718293a4b5c6d7e8f9012345678',
  'md5 d41d8cd98f00b204e9800998ecf8427e',
  'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  'id: 550e8400-e29b-41d4-a716-446655440000',
  'ID: 550E8400-E29B-41D4-A716-446655440000',
  'chunk-DkL9mQ2xPfa8.js',
  // addresses, dates and amounts
  'Server at 192.168.1.100 responded',
  'Released on 2026-09-03 at 18:11:42',
  'Order #1000234567 shipped',
  'Total 1 234 567 890 VND',
  'Elapsed 1234567890123 ns',
  // masked or placeholder secrets
  'password: ********',
  'API_KEY=your_api_key_here',
  'token=<REDACTED>',
  'SECRET=changeme',
  'apiKey: undefined',
  'password: null',
  'secret_key = os.environ["SECRET_KEY"]',
  'token: process.env.API_TOKEN',
  'Authorization: Bearer ${ACCESS_TOKEN_VALUE}',
  // long low-entropy or structured runs
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'abcdefghijklmnopqrstuvwxyzabcdefghij',
  'ThisIsAVeryLongCamelCaseIdentifierName',
  'Content-Security-Policy-Report-Only',
  'node --enable-source-maps --experimental-vm-modules',
  '/Users/minh/Projects/Capturia1/src/lib/redaction',
  // near-misses
  'sk-SK locale fallback',
  'user@localhost is not routable',
  '@media (min-width: 768px)',
  'background: #1a2b3c;',
  'SELECT * FROM users WHERE id = 42',
  'The quick brown fox jumps over the lazy dog',
  '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">',
]

describe('findSecrets — positives', () => {
  it('has a corpus of at least 30 positives', () => {
    expect(POSITIVES.length).toBeGreaterThanOrEqual(30)
  })

  for (const positive of POSITIVES) {
    it(`flags ${positive.kind} in ${JSON.stringify(positive.text.slice(0, 56))}`, () => {
      const matches = findSecrets(positive.text)
      const match = matches.find((m) => m.value === positive.value)
      expect(
        match,
        `expected ${positive.value} to be found, got ${JSON.stringify(matches)}`,
      ).toBeDefined()
      expect(match?.kind).toBe(positive.kind)
      expect(positive.text.slice(match?.start, match?.end)).toBe(positive.value)
    })
  }
})

describe('findSecrets — negatives', () => {
  it('has a corpus of at least 30 negatives', () => {
    expect(NEGATIVES.length).toBeGreaterThanOrEqual(30)
  })

  for (const text of NEGATIVES) {
    it(`ignores ${JSON.stringify(text.slice(0, 56))}`, () => {
      expect(findSecrets(text)).toEqual([])
    })
  }
})

describe('findSecrets — behaviour', () => {
  it('returns matches sorted by position and never overlapping', () => {
    const text =
      'mail ada@example.com then call 415-555-0132 with key ' +
      secret('sk-', 'live-9TQ4vn2XbLm7Zr5Kd8Hs1Wf')
    const matches = findSecrets(text)
    expect(matches.map((m) => m.kind)).toEqual(['email', 'phone', 'openai-key'])
    for (let i = 1; i < matches.length; i += 1) {
      expect(matches[i].start).toBeGreaterThanOrEqual(matches[i - 1].end)
    }
  })

  it('claims a JWT once rather than reporting its base64 segments separately', () => {
    const jwt = secret(
      'eyJ',
      'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJ' +
        'zdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    )
    const matches = findSecrets(jwt)
    expect(matches).toHaveLength(1)
    expect(matches[0].kind).toBe('jwt')
    expect(matches[0].value).toBe(jwt)
  })

  it('reports only the value of a labelled secret, not the label', () => {
    const [match] = findSecrets('DATABASE password: Tr0ub4dor3-horse-staple')
    expect(match.value).toBe('Tr0ub4dor3-horse-staple')
    expect(match.start).toBe('DATABASE password: '.length)
  })

  it('drops medium-confidence generics under minConfidence: high', () => {
    const text = 'X-Request-Auth xQ7pL2mV9bN4zR8tY1wC6eK3jH5gF0dS7aP2 for ada@example.com'
    expect(findSecrets(text).map((m) => m.kind)).toEqual(['base64-token', 'email'])
    expect(findSecrets(text, { minConfidence: 'high' }).map((m) => m.kind)).toEqual(['email'])
  })

  it('lowers the generic floor on request, for OCR text that splits tokens', () => {
    const short = 'residual Kd8Hs1WfxQ7pL2mV9bN4'
    expect(findSecrets(short)).toEqual([])
    expect(findSecrets(short, { minTokenLength: 20 }).map((m) => m.kind)).toEqual(['base64-token'])
  })

  it('clamps minTokenLength to the floor the detector regexes enforce', () => {
    expect(findSecrets('abc Kd8Hs1Wf', { minTokenLength: 4 })).toEqual([])
  })

  it('restricts the scan with kinds', () => {
    const text = 'ada@example.com called 415-555-0132'
    expect(findSecrets(text, { kinds: ['phone'] }).map((m) => m.value)).toEqual(['415-555-0132'])
  })

  it('handles empty and secret-free input', () => {
    expect(findSecrets('')).toEqual([])
    expect(hasSecret('nothing to see here')).toBe(false)
    expect(hasSecret('ada@example.com')).toBe(true)
  })

  it('exposes every detector kind', () => {
    expect(new Set(SECRET_KINDS)).toEqual(new Set(POSITIVES.map((p) => p.kind)))
  })
})

describe('maskSecrets', () => {
  it('replaces matches in place and preserves length', () => {
    const text = 'mail ada@example.com now'
    const masked = maskSecrets(text)
    expect(masked).toBe('mail ••••••••••••••• now')
    expect(masked.length).toBe(text.length)
  })

  it('returns the input untouched when nothing matches', () => {
    expect(maskSecrets('all clear')).toBe('all clear')
  })
})

describe('shannonEntropy', () => {
  it('is zero for a single repeated character and high for mixed input', () => {
    expect(shannonEntropy('')).toBe(0)
    expect(shannonEntropy('aaaaaaaa')).toBe(0)
    expect(shannonEntropy('abcd')).toBe(2)
    expect(shannonEntropy('xQ7pL2mV9bN4zR8tY1wC6eK3jH5gF0dS7aP2')).toBeGreaterThan(4)
  })
})
