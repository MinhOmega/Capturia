/**
 * Empty default export, used as the Vite alias target for Node builtins that
 * @xenova/transformers imports (`fs`, `path`, `url`). Its env.js reads an empty
 * object as "no filesystem" and stays on the browser/fetch paths.
 */
const empty = Object.create(null) as Record<string, never>
export default empty
