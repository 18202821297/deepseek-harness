/**
 * SSH file reading for the PVE collector. Password authentication through
 * `ssh2`; one connection per collect run, one `exec` per file. The connector
 * is injectable so unit tests can fake the transport without any network.
 * @module @deepseek-ai/dsh-pve-host/src/ssh
 */

/** Connection parameters for one server. */
export interface SshTarget {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
}

/** Result of reading one remote file. */
export interface SshFileResult {
  ok: boolean
  /** HTTP-ish status is not applicable; `error` carries the failure reason. */
  error: string
  /** File content when ok, else empty. */
  content: string
}

/** Minimal transport the collector needs: read files over one connection. */
export interface SshFileReader {
  /** Read one absolute file path; resolves with content or an error. */
  readFile(path: string): Promise<SshFileResult>
  /** Close the underlying connection (idempotent). */
  close(): void
}

/** Factory signature the service uses to obtain a reader. */
export type SshConnector = (target: SshTarget) => Promise<SshFileReader>

/** Default timeout for one exec command. */
const EXEC_TIMEOUT_MS = 30_000

/**
 * The production connector: opens a real `ssh2` connection with password
 * auth and reads files via `exec cat`.
 */
export const realSshConnector: SshConnector = async (target) => {
  const { Client } = await import('ssh2')
  const client = new Client()
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ssh connect timeout: ${target.host}:${target.port}`)), EXEC_TIMEOUT_MS)
    client
      .once('ready', () => { clearTimeout(timer); resolve() })
      .once('error', (error: Error) => { clearTimeout(timer); reject(new Error(`ssh connect failed: ${error.message}`)) })
  })
  client.connect({
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    readyTimeout: EXEC_TIMEOUT_MS,
  })
  await ready
  return {
    readFile(path: string): Promise<SshFileResult> {
      return new Promise((resolve) => {
        // The path is built by the Host from fixed literals (/var/log/pve/tasks/...);
        // shell quoting guards anyway against surprises.
        const quoted = `'${path.replaceAll('\'', '\'"\'"\'')}'`
        client.exec(`cat ${quoted}`, (error, stream) => {
          if (error !== undefined && error !== null) {
            resolve({ ok: false, error: `ssh exec failed: ${error.message}`, content: '' })
            return
          }
          const chunks: Buffer[] = []
          let stderr = ''
          stream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
          stream.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
          stream.once('close', (code: number | null) => {
            if (code !== 0) {
              resolve({ ok: false, error: `cat exited ${code}: ${stderr.trim()}`, content: '' })
              return
            }
            resolve({ ok: true, error: '', content: Buffer.concat(chunks).toString('utf8') })
          })
        })
      })
    },
    close(): void {
      client.end()
    },
  }
}
