import type { CatAddonManager, CatAddonManagerOptions } from './cat-addon'
import type { CatAddonRuntimeBundle } from '../shared/cat-addon-runtime'
import type { CatAddonState } from '../shared/types'

export interface CatAddonService {
  getState(): CatAddonState
  initializeIfEnabled(enabled: boolean): Promise<CatAddonState>
  cleanupDisabledInIdle(): Promise<CatAddonState>
  enable(): Promise<CatAddonState>
  disable(): Promise<CatAddonState>
  runtime(): Promise<CatAddonRuntimeBundle>
}

type ManagerLoader = () => Promise<typeof import('./cat-addon')>

const disabledState = (): CatAddonState => ({ enabled: false, installed: false, phase: 'disabled' })

export class LazyCatAddonService implements CatAddonService {
  private readonly options: CatAddonManagerOptions
  private readonly loadManagerModule: ManagerLoader
  private state = disabledState()
  private manager: CatAddonManager | undefined
  private managerPromise: Promise<CatAddonManager> | undefined

  constructor(options: CatAddonManagerOptions, loadManagerModule: ManagerLoader = () => import('./cat-addon')) {
    this.options = options
    this.loadManagerModule = loadManagerModule
  }

  getState(): CatAddonState {
    return { ...this.state }
  }

  async initializeIfEnabled(enabled: boolean): Promise<CatAddonState> {
    if (!enabled) return this.getState()
    return (await this.load()).initialize(true)
  }

  async cleanupDisabledInIdle(): Promise<CatAddonState> {
    if (this.state.enabled) return this.getState()
    return (await this.load()).initialize(false)
  }

  async enable(): Promise<CatAddonState> {
    this.updateState({ ...this.state, enabled: false, phase: 'enabling', error: undefined })
    return (await this.load()).enable()
  }

  async disable(): Promise<CatAddonState> {
    return (await this.load()).disable()
  }

  async runtime(): Promise<CatAddonRuntimeBundle> {
    if (!this.state.enabled) throw new Error('Cat Addon is not enabled.')
    return (await this.load()).runtime()
  }

  private updateState(state: CatAddonState): void {
    this.state = { ...state }
    this.options.onStateChanged?.(this.getState())
  }

  private load(): Promise<CatAddonManager> {
    if (this.manager) return Promise.resolve(this.manager)
    if (!this.managerPromise) {
      this.managerPromise = this.loadManagerModule().then(({ CatAddonManager }) => {
        const manager = new CatAddonManager({
          ...this.options,
          onStateChanged: (state) => this.updateState(state)
        })
        this.manager = manager
        return manager
      }).catch((error) => {
        this.managerPromise = undefined
        throw error
      })
    }
    return this.managerPromise
  }
}
