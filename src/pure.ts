import childProcess from 'child_process'
import stripFinalNewline from 'strip-final-newline'
import {RenderOptions, RenderResult, TestInstance} from '../types/pure'
import {_runObservers} from './mutation-observer'
import {getQueriesForElement} from './get-queries-for-instance'
import userEvent from './user-event'
import {bindObjectFnsToInstance, debounce, setCurrentInstance} from './helpers'
import {getConfig} from './config'
import {fireEvent} from './events'

const mountedInstances = new Set<TestInstance>()

async function render(
  command: string,
  args: string[] = [],
  opts: Partial<RenderOptions> = {},
): Promise<RenderResult> {
  const {cwd = __dirname, spawnOpts = {}} = opts

  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const exec = childProcess.spawn(command, args, {
    ...spawnOpts,
    cwd,
    shell: true,
  })

  let _readyPromiseInternals: null | {resolve: Function; reject: Function} =
    null

  let _isReadyResolved = false

  const execOutputAPI = {
    __exitCode: null as null | number,
    _isOutputAPI: true,
    _isReady: new Promise(
      (resolve, reject) => (_readyPromiseInternals = {resolve, reject}),
    ),
    // Clear buffer of stdout to do more accurate `t.regex` checks
    clear() {
      execOutputAPI.stdoutArr = []
    },
    // An array of strings gathered from stdout when unable to do
    // `await stdout` because of inquirer interactive prompts
    stdoutArr: [] as Array<string | Buffer>,
    get stdoutStr(): string {
      return this.stdoutArr.join('\n')
    },
    set stdoutStr(val: string) {},
    hasExit() {
      return this.__exitCode === null ? null : {exitCode: this.__exitCode}
    },
  }

  mountedInstances.add(execOutputAPI as unknown as TestInstance)

  /**
   * This method does not throw errors after-the-fact,
   * meaning that if post-render errors are thrown,
   * they will be missed
   *
   * THINK: Should we should simply `throw` when this occurs?
   * What about cleanup?
   * What about interactive errors?
   */
  let _errorHasOccured = false
  const _errors: Array<string | Buffer | Error> = []

  exec.stdout.on('data', (result: string | Buffer) => {
    const resStr = stripFinalNewline(result as string)
    execOutputAPI.stdoutArr.push(resStr)
    _runObservers()
    if (!_errorHasOccured && _readyPromiseInternals && !_isReadyResolved) {
      _readyPromiseInternals.resolve()
      _isReadyResolved = true
    }
    // stdout might contain relevant error info
    if (_errorHasOccured && _readyPromiseInternals && !_isReadyResolved) {
      _errors.push(result)
    }
  })

  const _onError = () => {
    if (!_readyPromiseInternals) return
    _readyPromiseInternals.reject(new Error(_errors.join('\n')))
    _isReadyResolved = true
  }

  const config = getConfig()
  const _throttledOnError = debounce(_onError, config.errorDebounceTimeout)

  exec.stdout.on('error', result => {
    if (_readyPromiseInternals && !_isReadyResolved) {
      _errors.push(result)
      _throttledOnError()
      _errorHasOccured = true
    }
  })

  exec.stderr.on('data', (result: string) => {
    if (_readyPromiseInternals && !_isReadyResolved) {
      _errors.push(result)
      _throttledOnError()
      _errorHasOccured = true
    }
  })

  exec.on('exit', code => {
    execOutputAPI.__exitCode = code ?? 0
  })

  // TODO: Replace with `debug()` function
  if (opts.debug) {
    exec.stdout.pipe(process.stdout)
  }

  await execOutputAPI._isReady

  setCurrentInstance(execOutputAPI)

  return Object.assign(
    execOutputAPI,
    {
      stdin: exec.stdin,
      stdout: exec.stdout,
      stderr: exec.stderr,
      pid: exec.pid,
      userEvent: bindObjectFnsToInstance(execOutputAPI, userEvent),
      kill: exec.kill.bind(exec),
    },
    getQueriesForElement(execOutputAPI),
  ) as TestInstance as RenderResult
}

function cleanup() {
  return Promise.all([...mountedInstances].map(cleanupAtInstance))
}

// maybe one day we'll expose this (perhaps even as a utility returned by render).
// but let's wait until someone asks for it.
async function cleanupAtInstance(instance: TestInstance) {
  await fireEvent.sigkill(instance)
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  mountedInstances.delete(instance)
}

export {render, cleanup}
