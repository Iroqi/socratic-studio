// 模型订阅目录：哪些 provider 可选、各自怎么认证、对应哪些环境变量。
//
// 参考 @earendil-works/pi-ai 的 provider 设计：
//   provider 是运行时单位，自己持有模型目录 + auth + stream 行为；
//   Models 集合按 model.provider 路由请求；auth 解析顺序是
//   显式 apiKey > 已存 credential > 环境变量。
//
// 这里只登记「本应用要暴露给用户的订阅方式」：
//   - kind: 'key'    → 用户在弹出的配置面板里粘一个 API key
//   - kind: 'local'  → 本地/自建端点，无 key 也合法（Ollama / vLLM / LM Studio）

/** kind 'key' 的内置订阅：providerId 必须与 pi-ai 的 provider 工厂 id 一致。 */
export const BUILTIN_KEY_PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', factory: 'deepseekProvider', env: ['DEEPSEEK_API_KEY'], keyHint: 'sk-…', docs: 'https://platform.deepseek.com/api_keys' },
  { id: 'openai', label: 'OpenAI', factory: 'openaiProvider', env: ['OPENAI_API_KEY'], keyHint: 'sk-…', docs: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', factory: 'anthropicProvider', env: ['ANTHROPIC_API_KEY'], keyHint: 'sk-ant-…', docs: 'https://console.anthropic.com/settings/keys' },
  { id: 'google', label: 'Google Gemini', factory: 'googleProvider', env: ['GEMINI_API_KEY'], keyHint: 'AIza…', docs: 'https://aistudio.google.com/app/apikey' },
  { id: 'openrouter', label: 'OpenRouter（多模型中转）', factory: 'openrouterProvider', env: ['OPENROUTER_API_KEY'], keyHint: 'sk-or-…', docs: 'https://openrouter.ai/keys' },
  { id: 'xai', label: 'xAI (Grok)', factory: 'xaiProvider', env: ['XAI_API_KEY'], keyHint: 'xai-…', docs: 'https://console.x.ai' },
  { id: 'groq', label: 'Groq', factory: 'groqProvider', env: ['GROQ_API_KEY'], keyHint: 'gsk_…', docs: 'https://console.groq.com/keys' },
  { id: 'mistral', label: 'Mistral', factory: 'mistralProvider', env: ['MISTRAL_API_KEY'], keyHint: '', docs: 'https://console.mistral.ai/api-keys' },
  { id: 'moonshotai', label: 'Moonshot (Kimi)', factory: 'moonshotaiProvider', env: ['MOONSHOT_API_KEY'], keyHint: 'sk-…', docs: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'zai', label: 'Z.ai (GLM)', factory: 'zaiProvider', env: ['ZAI_API_KEY'], keyHint: '', docs: 'https://open.bigmodel.cn' },
  { id: 'minimax', label: 'MiniMax', factory: 'minimaxProvider', env: ['MINIMAX_API_KEY'], keyHint: '', docs: 'https://platform.minimaxi.com' },
  { id: 'together', label: 'Together AI', factory: 'togetherProvider', env: ['TOGETHER_API_KEY'], keyHint: '', docs: 'https://api.together.xyz/settings/api-keys' },
  { id: 'cerebras', label: 'Cerebras', factory: 'cerebrasProvider', env: ['CEREBRAS_API_KEY'], keyHint: 'csk-…', docs: 'https://cloud.cerebras.ai' },
  { id: 'nvidia', label: 'NVIDIA NIM', factory: 'nvidiaProvider', env: ['NVIDIA_API_KEY'], keyHint: 'nvapi-…', docs: 'https://build.nvidia.com' },
  { id: 'huggingface', label: 'Hugging Face', factory: 'huggingfaceProvider', env: ['HF_TOKEN'], keyHint: 'hf_…', docs: 'https://huggingface.co/settings/tokens' },
  { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', factory: 'vercelAiGatewayProvider', env: ['AI_GATEWAY_API_KEY'], keyHint: '', docs: 'https://vercel.com/docs/ai-gateway' },
  { id: 'fireworks', label: 'Fireworks', factory: 'fireworksProvider', env: ['FIREWORKS_API_KEY'], keyHint: 'fw_…', docs: 'https://fireworks.ai/account/api-keys' },
  { id: 'baseten', label: 'Baseten', factory: 'basetenProvider', env: ['BASETEN_API_KEY'], keyHint: '', docs: 'https://docs.baseten.co' },
];

/**
 * pi-ai 的 `providers/<subpath>` 子路径 → 导出名，仅用于动态 import。
 * 与 BUILTIN_KEY_PROVIDERS 分开维护：import 路径是 pi-ai 的包布局，不是本应用的概念。
 */
export const PROVIDER_FACTORY_MODULES = {
  deepseek: ['deepseek', 'deepseekProvider'],
  openai: ['openai', 'openaiProvider'],
  anthropic: ['anthropic', 'anthropicProvider'],
  google: ['google', 'googleProvider'],
  openrouter: ['openrouter', 'openrouterProvider'],
  xai: ['xai', 'xaiProvider'],
  groq: ['groq', 'groqProvider'],
  mistral: ['mistral', 'mistralProvider'],
  moonshotai: ['moonshotai', 'moonshotaiProvider'],
  zai: ['zai', 'zaiProvider'],
  minimax: ['minimax', 'minimaxProvider'],
  together: ['together', 'togetherProvider'],
  cerebras: ['cerebras', 'cerebrasProvider'],
  nvidia: ['nvidia', 'nvidiaProvider'],
  huggingface: ['huggingface', 'huggingfaceProvider'],
  'vercel-ai-gateway': ['vercel-ai-gateway', 'vercelAIGatewayProvider'],
  fireworks: ['fireworks', 'fireworksProvider'],
  baseten: ['baseten', 'basetenProvider'],
};

/** 自定义订阅 = 用户自己填 baseUrl 的 OpenAI 兼容端点。
    每个端点一个 provider id：custom-endpoint / custom-endpoint-2 / …（运行时注册单位是 provider，
    一个 provider 只有一份 baseUrl；同一 baseUrl 挂多个模型 id 的用法，用「添加模型」在同一份配置里加）。 */
export const CUSTOM_PROVIDER_ID = 'custom-endpoint';
export const customEndpointId = (index) => (index <= 1 ? CUSTOM_PROVIDER_ID : `custom-endpoint-${index}`);
export const customEndpointIndex = (id) => (id === CUSTOM_PROVIDER_ID ? 1 : Number(String(id).replace(/^custom-endpoint-?/, '')) || 1);
/** 只认 custom-endpoint / custom-endpoint-N 这一种形状。
    必须严格：上面那个 index 函数对认不出的 id 一律兜成 1 号槽，于是
    `PUT /api/custom-endpoints/<拼错或编出来的 id>` 会覆盖掉用户存好的第一个端点。 */
export const isCustomEndpointId = (id) => /^custom-endpoint(?:-[1-9]\d*)?$/.test(String(id ?? ''));

/** 订阅状态取值。 */
export const AUTH_STATE = {
  CONFIGURED: 'configured',   // 有可用的 key（本地端点无需 key 也算）
  ENV: 'env',                 // 由环境变量提供，未在应用里存过
  MISSING: 'missing',         // 没配
};
