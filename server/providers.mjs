// 模型订阅接入层：CredentialStore、Models 集合、可用模型清单。
//
// 契约来自 @earendil-works/pi-ai：
//   - 一个 provider 一份 credential；CredentialStore 只提供 read/list/modify/delete，
//     modify 是唯一的写路径（串行的 read-modify-write），OAuth 刷新也走它。
//   - 存过的 credential 「拥有」这个 provider：只有什么都没存时才回落到环境变量。
//   - auth 解析顺序：显式 apiKey > 存过的 credential > 环境变量。

import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {
  BUILTIN_KEY_PROVIDERS,
  PROVIDER_FACTORY_MODULES,
  CUSTOM_PROVIDER_ID,
  customEndpointId,
  customEndpointIndex,
  AUTH_STATE,
} from './providers-catalog.mjs';
import {
  CREDENTIALS_FILE,
  SETTINGS_FILE,
  writeJsonAtomic,
  readJsonSafe,
} from './config.mjs';

// ---------------------------------------------------------------- credential store

/** 文件版 CredentialStore：进程内串行化，落盘原子写。 */
class FileCredentialStore {
  #file;
  #chain = Promise.resolve();

  constructor(file) {
    this.#file = file;
  }

  #load() {
    return readJsonSafe(this.#file, {});
  }

  async read(providerId) {
    const all = this.#load();
    const entry = all[providerId];
    return entry ? structuredClone(entry) : undefined;
  }

  /** 只回非密元数据，绝不解析 secret。 */
  async list() {
    const all = this.#load();
    return Object.entries(all).map(([providerId, cred]) => ({
      providerId,
      type: cred?.type ?? 'api_key',
    }));
  }

  /** 配置备份：整份凭据原样导出（含密钥——这是备份的本意，调用方标注"勿外传"）。 */
  async exportAll() {
    return structuredClone(this.#load());
  }

  /**
   * 配置备份：整份凭据一次性替换。只接受普通对象（值是任意 JSON），
   * 写进固定的 CREDENTIALS_FILE，无路径注入面。走同一把串行写链，不打断并发读写。
   */
  async replaceAll(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('凭据必须是对象');
    const run = this.#chain.then(async () => {
      writeJsonAtomic(this.#file, data);
      return structuredClone(data);
    });
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 唯一写路径：串行的 read-modify-write。 */
  modify(providerId, fn) {
    const run = this.#chain.then(async () => {
      const all = this.#load();
      const current = all[providerId] ? structuredClone(all[providerId]) : undefined;
      const next = await fn(current);
      if (next === undefined) delete all[providerId];
      else all[providerId] = next;
      writeJsonAtomic(this.#file, all);
      return next === undefined ? undefined : structuredClone(next);
    });
    // 失败不毒化后续调用
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async delete(providerId) {
    await this.modify(providerId, () => undefined);
  }
}

// ---------------------------------------------------------------- settings

const DEFAULT_SETTINGS = {
  activeModel: null, // { provider, model }
  custom: null,      // 旧版单端点（legacy，兼容读取；新数据走 customEndpoints）
  customEndpoints: [], // 多端点：[{ label, baseUrl, modelId, modelName, contextWindow, ... }]
  recent: [],
};

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJsonSafe(SETTINGS_FILE, {}) };
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  writeJsonAtomic(SETTINGS_FILE, next);
  return next;
}

// ---------------------------------------------------------------- models collection

/** 每个 provider 的动态 import 只做一次。 */
const factoryCache = new Map();

async function loadFactory(providerId) {
  if (factoryCache.has(providerId)) return factoryCache.get(providerId);
  const entry = PROVIDER_FACTORY_MODULES[providerId];
  if (!entry) throw new Error(`unknown provider: ${providerId}`);
  const [subpath, exportName] = entry;
  const mod = await import(`@earendil-works/pi-ai/providers/${subpath}`);
  const factory = mod[exportName];
  if (typeof factory !== 'function') {
    throw new Error(`provider factory ${exportName} not exported by ${subpath}`);
  }
  factoryCache.set(providerId, factory);
  return factory;
}

export class ProviderRegistry {
  constructor() {
    this.credentials = new FileCredentialStore(CREDENTIALS_FILE);
    this.models = createModels({ credentials: this.credentials });
    this.loaded = new Set();
    this.loadErrors = new Map();
    // 每个自定义端点一个 provider（custom-endpoint / -2 / -3…），每个 provider 一份配置。
    this.customConfigs = new Map(); // providerId -> 配置对象的 JSON signature
  }

  /** 所有已配置的自定义端点（含 legacy 的 settings.custom 单数形态）。 */
  customEndpointConfigs() {
    return [...this.customConfigs.entries()].map(([id, sig]) => JSON.parse(sig));
  }

  /** 幂等注册一个内置 provider；import 失败只记录、不炸掉整个服务。 */
  async ensureBuiltin(providerId) {
    if (this.loaded.has(providerId)) return true;
    try {
      const factory = await loadFactory(providerId);
      this.models.setProvider(factory());
      this.loaded.add(providerId);
      this.loadErrors.delete(providerId);
      return true;
    } catch (err) {
      this.loadErrors.set(providerId, err.message);
      return false;
    }
  }

  /** 注册一次全部内置 provider（模型配置页要用全量目录）。 */
  async ensureAllBuiltin() {
    const results = await Promise.all(
      BUILTIN_KEY_PROVIDERS.map((p) => this.ensureBuiltin(p.id)),
    );
    return BUILTIN_KEY_PROVIDERS.filter((_, i) => !results[i]);
  }

  /** 自定义 OpenAI 兼容端点：按用户在设置里填的 baseUrl / 模型信息重建。
      index 决定 provider id（1 → custom-endpoint 兼容旧数据；2、3… → custom-endpoint-N）。 */
  ensureCustom(config, index = 1) {
    const providerId = customEndpointId(index);
    const cfg = config?.baseUrl ? config : null;
    if (!cfg) {
      this.customConfigs.delete(providerId);
      this.loaded.delete(providerId);
      // 运行时不支持移除已注册 provider 时不硬抛：注销不了就留着（配置标记已删）
      return;
    }
    const signature = JSON.stringify(cfg);
    if (this.customConfigs.get(providerId) === signature) return;
    const modelId = cfg.modelId || 'default';
    const provider = createProvider({
      id: providerId,
      name: cfg.label || '自定义端点',
      baseUrl: cfg.baseUrl,
      auth: {
        apiKey: {
          name: '自定义端点 API key',
          resolve: async () => {
            const stored = await this.credentials.read(providerId);
            const key = stored?.key || process.env.CUSTOM_ENDPOINT_API_KEY || '';
            return { auth: key ? { apiKey: key } : {} };
          },
        },
      },
      models: [
        {
          id: modelId,
          name: cfg.modelName || modelId,
          api: 'openai-completions',
          provider: providerId,
          baseUrl: cfg.baseUrl,
          reasoning: Boolean(cfg.reasoning),
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: Number(cfg.contextWindow) || 128000,
          maxTokens: Number(cfg.maxTokens) || 8192,
          // 自建端点常见的兼容开关：Ollama / vLLM / LM Studio 不认 developer 角色
          compat: {
            supportsDeveloperRole: cfg.supportsDeveloperRole !== false,
            supportsReasoningEffort: Boolean(cfg.supportsReasoningEffort),
          },
        },
      ],
      api: openAICompletionsApi(),
    });
    this.models.setProvider(provider);
    this.customConfigs.set(providerId, signature);
    this.loaded.add(providerId);
  }

  /** 某个订阅当前的认证状态（只看得到"有没有配"，拿不到 key 本身）。 */
  async authStateOf(providerId) {
    const def = BUILTIN_KEY_PROVIDERS.find((p) => p.id === providerId);
    if (!def && !providerId.startsWith('custom-endpoint')) return AUTH_STATE.MISSING;
    const stored = await this.credentials.read(providerId);
    if (stored?.key) return AUTH_STATE.CONFIGURED;
    if (providerId.startsWith('custom-endpoint')) {
      return this.customConfigs.has(providerId) ? AUTH_STATE.CONFIGURED : AUTH_STATE.MISSING;
    }
    if (def.env.some((name) => process.env[name])) return AUTH_STATE.ENV;
    return AUTH_STATE.MISSING;
  }

  /** 面向配置页的订阅列表：内置 key 订阅 + 各自定义端点。 */
  async subscriptionList() {
    const out = [];
    for (const def of BUILTIN_KEY_PROVIDERS) {
      const ok = this.loaded.has(def.id);
      const models = ok ? this.models.getModels(def.id) : [];
      out.push({
        id: def.id,
        label: def.label,
        kind: 'key',
        env: def.env,
        keyHint: def.keyHint,
        docs: def.docs,
        available: ok,
        loadError: this.loadErrors.get(def.id) ?? null,
        auth: await this.authStateOf(def.id),
        modelCount: models.length,
        requiresKey: true,
      });
    }
    for (const [id, sig] of this.customConfigs) {
      const cfg = JSON.parse(sig);
      out.push({
        id,
        label: cfg.label || `自建端点 ${customEndpointIndex(id)}`,
        kind: 'custom',
        baseUrl: cfg.baseUrl,
        modelId: cfg.modelId || 'default',
        modelName: cfg.modelName,
        contextWindow: cfg.contextWindow,
        reasoning: Boolean(cfg.reasoning),
        supportsReasoningEffort: Boolean(cfg.supportsReasoningEffort),
        supportsDeveloperRole: cfg.supportsDeveloperRole !== false,
        env: [],
        keyHint: '',
        docs: null,
        available: true,
        loadError: null,
        auth: await this.authStateOf(id),
        modelCount: 1,
        requiresKey: false,
      });
    }
    return out;
  }

  /** 可用（已配好的）模型清单，用于顶栏模型选择器。 */
  async availableModels() {
    const out = [];
    for (const def of BUILTIN_KEY_PROVIDERS) {
      if (!this.loaded.has(def.id)) continue;
      const state = await this.authStateOf(def.id);
      if (state === AUTH_STATE.MISSING) continue;
      for (const m of this.models.getModels(def.id)) {
        out.push({
          provider: def.id,
          providerLabel: def.label,
          model: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          reasoning: Boolean(m.reasoning),
          vision: Array.isArray(m.input) && m.input.includes('image'),
          source: state,
        });
      }
    }
    // 本地/自建端点即使没 key 也列为"可用"——它本来就不需要 key。
    // provider id 就是端点自己的 provider id（custom-endpoint / -2 / …），
    // 这样 activeModel 的 {provider, model} 能精确路由到对应端点。
    for (const [id, sig] of this.customConfigs) {
      const cfg = JSON.parse(sig);
      out.push({
        provider: id,
        providerLabel: cfg.label || `自建端点 ${customEndpointIndex(id)}`,
        model: cfg.modelId || 'default',
        name: cfg.modelName || cfg.modelId || 'default',
        contextWindow: Number(cfg.contextWindow) || 128000,
        reasoning: Boolean(cfg.reasoning),
        vision: true,
        source: AUTH_STATE.CONFIGURED,
      });
    }
    return out;
  }

  /** 解析出一个可 stream 的 model 对象。 */
  resolveModel({ provider, model }) {
    if (provider.startsWith('custom-endpoint')) {
      if (!this.customConfigs.has(provider)) throw new Error('该自建端点尚未配置');
      const cfg = JSON.parse(this.customConfigs.get(provider));
      const m = this.models.getModel(provider, cfg.modelId || 'default');
      if (!m) throw new Error('该自建端点的模型不可用');
      return m;
    }
    const exact = this.models.getModel(provider, model);
    if (exact) return exact;
    // 回退：给出这个 provider 下第一个可用的 chat 模型。
    // 用途是「目录里的 id 变了」或「只有一个模型的本地/测试 provider」，
    // 让用户不至于因为一个过期的 id 就完全用不了。
    const fallbacks = this.models.getModels(provider);
    if (fallbacks?.length) return fallbacks[0];
    throw new Error(
      `模型 ${provider}/${model} 不在目录中（该订阅未配置，或模型 id 已变更）`,
    );
  }

  /** 保存某个订阅的 API key。 */
  async setApiKey(providerId, key) {
    const trimmed = String(key ?? '').trim();
    if (!trimmed) {
      const err = new Error('API key 不能为空');
      err.status = 400;
      throw err;
    }
    await this.credentials.modify(providerId, () => ({
      type: 'api_key',
      key: trimmed,
    }));
  }

  async clearApiKey(providerId) {
    await this.credentials.delete(providerId);
  }
}

export async function createRegistry() {
  const registry = new ProviderRegistry();
  const settings = loadSettings();
  // 旧版单端点 settings.custom → 新多端点 customEndpoints[0]（一次性迁移，不覆盖已有数据）
  if (Array.isArray(settings.customEndpoints) && settings.customEndpoints.length) {
    settings.customEndpoints.forEach((cfg, i) => {
      try {
        registry.ensureCustom(cfg, i + 1);
      } catch {
        /* 某个端点配置坏了就跳过，配置页会提示重填 */
      }
    });
  } else if (settings.custom) {
    try {
      registry.ensureCustom(settings.custom, 1);
    } catch {
      /* 配置坏了就当没配，配置页会提示重填 */
    }
  }
  return registry;
}

export { CUSTOM_PROVIDER_ID, AUTH_STATE, customEndpointId, customEndpointIndex };
