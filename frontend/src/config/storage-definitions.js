export const STORAGE_TYPES = [
  {
    value: 'telegram',
    label: 'Telegram',
    layer: 'direct',
    description: '简单稳定的上传目标。',
  },
  {
    value: 'r2',
    label: 'R2',
    layer: 'direct',
    description: '适合大文件和 CDN 场景的对象存储。',
  },
  {
    value: 's3',
    label: 'S3',
    layer: 'direct',
    description: '任意兼容 S3 协议的存储服务。',
  },
  {
    value: 'discord',
    label: 'Discord',
    layer: 'direct',
    description: '通过 Webhook 或 Bot 上传到 Discord。',
  },
  {
    value: 'huggingface',
    label: 'HuggingFace',
    layer: 'direct',
    description: '使用数据集仓库作为轻量存储后端。',
  },
  {
    value: 'webdav',
    label: 'WebDAV',
    layer: 'mounted',
    description: '挂载型或聚合型存储入口，推荐配合 alist/openlist 使用。',
  },
  {
    value: 'github',
    label: 'GitHub',
    layer: 'direct',
    description: '使用 Release 附件或 Contents API 上传。',
  },
];

export const STORAGE_TYPE_LABELS = STORAGE_TYPES.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});

export const STORAGE_FIELDS = {
  telegram: [
    { key: 'botToken', label: '机器人 Token', required: true, secret: true, placeholder: '123456:ABC...' },
    { key: 'chatId', label: '聊天 ID', required: true, placeholder: '-100xxxx' },
    { key: 'apiBase', label: 'API 地址', placeholder: 'https://api.telegram.org' },
  ],
  r2: [
    { key: 'endpoint', label: '端点地址', required: true, placeholder: 'https://xxxx.r2.cloudflarestorage.com' },
    { key: 'region', label: '区域', placeholder: 'auto' },
    { key: 'bucket', label: '存储桶', required: true, placeholder: 'bucket-name' },
    { key: 'accessKeyId', label: '访问密钥 ID', required: true, secret: true, placeholder: 'AKIA...' },
    { key: 'secretAccessKey', label: '访问密钥 Secret', required: true, secret: true, placeholder: '******' },
  ],
  s3: [
    { key: 'endpoint', label: '端点地址', required: true, placeholder: 'https://s3.example.com' },
    { key: 'region', label: '区域', required: true, placeholder: 'us-east-1' },
    { key: 'bucket', label: '存储桶', required: true, placeholder: 'bucket-name' },
    { key: 'accessKeyId', label: '访问密钥 ID', required: true, secret: true, placeholder: 'AKIA...' },
    { key: 'secretAccessKey', label: '访问密钥 Secret', required: true, secret: true, placeholder: '******' },
  ],
  discord: [
    { key: 'webhookUrl', label: 'Webhook 地址', secret: true, placeholder: 'https://discord.com/api/webhooks/...' },
    { key: 'botToken', label: '机器人 Token', secret: true, placeholder: '机器人 Token' },
    { key: 'channelId', label: '频道 ID', placeholder: '频道 ID' },
  ],
  huggingface: [
    { key: 'token', label: '访问 Token', required: true, secret: true, placeholder: 'hf_xxx' },
    { key: 'repo', label: '数据集仓库', required: true, placeholder: 'username/repo' },
    {
      key: 'capacityThresholdGb',
      label: '参考容量阈值 (GB)',
      input: 'number',
      default: '100',
      placeholder: '100',
    },
  ],
  webdav: [
    { key: 'baseUrl', label: '基础地址', required: true, placeholder: 'https://dav.example.com/remote.php/dav/files/user' },
    { key: 'username', label: '用户名', placeholder: '使用 Bearer Token 时可留空' },
    { key: 'password', label: '密码', secret: true, placeholder: '使用 Bearer Token 时可留空' },
    { key: 'bearerToken', label: 'Bearer Token', secret: true, placeholder: '使用用户名 + 密码时可留空' },
    { key: 'rootPath', label: '根路径', placeholder: '可选路径前缀，例如 uploads' },
  ],
  github: [
    { key: 'repo', label: '仓库', required: true, placeholder: 'owner/repo' },
    { key: 'token', label: '访问 Token', required: true, secret: true, placeholder: 'github_pat_xxx' },
    {
      key: 'mode',
      label: '模式',
      input: 'select',
      required: true,
      options: [
        { value: 'releases', label: 'Releases 发布附件' },
        { value: 'contents', label: 'Contents API 内容接口' },
      ],
    },
    { key: 'prefix', label: '路径前缀', placeholder: '可选，例如 uploads' },
    { key: 'releaseTag', label: '发布标签', placeholder: '可选，仅在 Releases 模式下使用' },
    { key: 'branch', label: '分支', placeholder: '可选，仅在 Contents 模式下使用' },
    { key: 'apiBase', label: 'API 地址', placeholder: 'https://api.github.com' },
  ],
};

export const STORAGE_NOTES = {
  telegram: '实际稳定上传上限建议控制在 50MB 以内。',
  discord: '适配器当前采用较保守的 25MB 上传限制。',
  huggingface: '会根据仓库已用容量与参考阈值自动切换到下一个已启用仓库，默认参考阈值为 100GB。',
  webdav: '支持 PUT/GET/DELETE，并会为多级目录自动创建 MKCOL。',
  github: '二进制文件更推荐 Releases 模式；Contents 模式更适合小文件或文本，但 API 限制更严格。',
};

export const STORAGE_GROUPS = [
  {
    value: 'direct',
    label: '直连上传后端',
    description: '这些后端由 K-Vault 直接上传。',
  },
  {
    value: 'mounted',
    label: '挂载 / 聚合后端',
    description: '适合 WebDAV 挂载点，例如 alist/openlist。',
  },
];

export function getStorageFields(type) {
  return STORAGE_FIELDS[type] || [];
}

export function getStorageLabel(type) {
  return STORAGE_TYPE_LABELS[type] || String(type || '');
}

export function storageEnabledFromStatus(status, type) {
  if (!status || !type) return false;
  const item = status[type];
  if (!item) return false;
  return Boolean(item.connected && (item.enabled !== false));
}
