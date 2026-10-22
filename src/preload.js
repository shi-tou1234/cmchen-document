const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pdfBridge', {
  // 主应用窗口标记（main.js 的 additionalArguments）；独立测试窗口为 false
  isApp: process.argv.includes('--pdfreader-app'),
  // 主动请求主进程弹出打开对话框，返回 { ok, kind, fileName, filePath, startPage, data|pages }
  openPdfDialog: () => ipcRenderer.invoke('open-pdf-dialog'),
  // 只选文档路径（可多选），不读取/转换内容；库界面「添加文档」用
  pickDocuments: () => ipcRenderer.invoke('pick-documents'),
  // 订阅来自菜单「打开 PDF」/最近文件/命令行 的打开事件
  onPdfOpened: (cb) => {
    ipcRenderer.on('pdf-opened', (_e, payload) => cb(payload));
  },
  // 拖拽进来的 File 取真实磁盘路径（Electron 32 起 File.path 被移除，必须走 webUtils）
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch (_) { return ''; }
  },
  // v18：文档快速切换用——最近打开列表 / 直接打开某个路径
  recentList: () => ipcRenderer.invoke('recent-list'),
  openPath: (path) => ipcRenderer.invoke('open-path', { path }),
  // 上报当前页码（主进程按文件记住，下次打开回到同一页）
  reportPage: (path, page) => ipcRenderer.send('set-page', { path, page }),
  // 拖拽打开的文件也要进「最近打开」
  noteRecent: (path, page) => ipcRenderer.invoke('note-recent', { path, page }),
  // 冒烟模式回报结果
  reportSmoke: (data) => ipcRenderer.send('smoke-result', data),
  // 导出带标注的 PDF 副本（payload: { fileName, data, pages, outPath? }）
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload),
  // 更新窗口标题
  setTitle: (t) => ipcRenderer.send('set-title', t),
  // 标注自动保存 / 恢复（按文件路径）
  saveAnnos: (path, pages) => ipcRenderer.invoke('anno-save', { path, pages }),
  loadAnnos: (path) => ipcRenderer.invoke('anno-load', { path }),
  // 标注条目化 —— 汇总所有文档的标注 + 给标注打标签
  listAnnotations: () => ipcRenderer.invoke('anno-list'),
  setAnnoTags: (id, tags) => ipcRenderer.invoke('anno-set-tags', { id, tags }),
  addAnnoTags: (ids, tags) => ipcRenderer.invoke('anno-add-tags', { ids, tags }),
  removeAnnoTag: (id, tag) => ipcRenderer.invoke('anno-remove-tag', { id, tag }),
  // v8：标注是库里的对象 —— 可编辑文字/批注/颜色，可与条目双向关联
  updateAnno: (id, patch) => ipcRenderer.invoke('anno-update', { id, patch }),
  linkAnno: (id, itemKey) => ipcRenderer.invoke('anno-link', { id, itemKey }),
  onAnnoReload: (cb) => { ipcRenderer.on('anno-reload', (_e, info) => cb(info)); },
  // v8：从标注生成带页面截图的笔记
  noteFromAnno: (info) => ipcRenderer.invoke('note-from-anno', info),
  noteImage: (path) => ipcRenderer.invoke('note-image', { path }),
  // v9：图片标注落盘（灯箱「存为标注」）
  saveImageAnno: (info) => ipcRenderer.invoke('anno-save-image', info),
  // 批注导出为纯文本笔记
  exportNote: (info) => ipcRenderer.invoke('export-note', info),
  // 菜单命令：专注阅读模式 / 导出当前页图片（主进程菜单触发）
  onToggleFocusMode: (cb) => { ipcRenderer.on('toggle-focus-mode', () => cb()); },
  onExportPagePng: (cb) => { ipcRenderer.on('export-page-png', () => cb()); },
  // 复制纯文本到系统剪贴板（v14：复制引用等）
  copyText: (text) => ipcRenderer.invoke('copy-text', { text }),
  // v9：打开网页链接（笔记 Markdown 预览里的链接）
  openExternal: (url) => ipcRenderer.invoke('open-external', { url }),
  // v9：打印当前文档（交给系统默认程序）
  printFile: (path) => ipcRenderer.invoke('print-file', { path }),
  // v20：把当前页导出成 PNG（数据是 dataURL）
  exportPagePng: (info) => ipcRenderer.invoke('export-page-png', info),
  // v21：把所有文档的批注汇总成一份 Markdown（outPath 可选，给了就不弹对话框）
  exportAllNotes: (outPath) => ipcRenderer.invoke('export-all-notes', { outPath }),
  // 通用「保存文本」对话框（参考文献表用；Markdown / 纯文本）
  saveText: (info) => ipcRenderer.invoke('save-text', info),
  // v26：去掉原生菜单栏（文件/视图/系统）后，这几件事改从界面发起
  clearRecent: () => ipcRenderer.invoke('clear-recent'),
  setDefaultPdfReader: () => ipcRenderer.invoke('set-default-pdf-reader'),
  openDevTools: () => ipcRenderer.invoke('open-devtools'),
  appInfo: () => ipcRenderer.invoke('app-info'),
  // 应用设置（v11）
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  // 菜单/主进程改动库后通知库界面刷新
  onLibChanged: (cb) => { ipcRenderer.on('lib-changed', () => cb()); },
  onOpenSettings: (cb) => { ipcRenderer.on('open-settings', () => cb()); },
  // 本地文献库 API
  lib: {
    summary: () => ipcRenderer.invoke('lib-summary'),
    addPdf: (path, opts) => ipcRenderer.invoke('lib-add-pdf', { path, opts }),
    // v9：独立笔记条目
    newNote: (info) => ipcRenderer.invoke('lib-new-note', info),
    openItem: (key, page) => ipcRenderer.invoke('lib-open-item', { key, page }),
    updateItem: (key, patch) => ipcRenderer.invoke('lib-update-item', { key, patch }),
    // 回收站：removeItem 现在等于“移入回收站”（软删除）
    removeItem: (key) => ipcRenderer.invoke('lib-remove-item', { key }),
    trashItem: (key) => ipcRenderer.invoke('lib-trash-item', { key }),
    restoreItem: (key) => ipcRenderer.invoke('lib-restore-item', { key }),
    deleteItem: (key) => ipcRenderer.invoke('lib-delete-item', { key }),
    emptyTrash: () => ipcRenderer.invoke('lib-empty-trash'),
    addCollection: (name, parentId) => ipcRenderer.invoke('lib-add-collection', { name, parentId }),
    removeCollection: (id) => ipcRenderer.invoke('lib-remove-collection', { id }),
    renameCollection: (id, name) => ipcRenderer.invoke('lib-rename-collection', { id, name }),
    setCollectionColor: (id, color) => ipcRenderer.invoke('lib-set-collection-color', { id, color }),
    setTagColor: (tag, color) => ipcRenderer.invoke('lib-set-tag-color', { tag, color }),
    addRelation: (key, otherKey) => ipcRenderer.invoke('lib-add-relation', { key, otherKey }),
    removeRelation: (key, otherKey) => ipcRenderer.invoke('lib-remove-relation', { key, otherKey }),
    moveItem: (key, collectionId) => ipcRenderer.invoke('lib-move-item', { key, collectionId }),
    setCollections: (key, collectionIds) => ipcRenderer.invoke('lib-set-collections', { key, collectionIds }),
    addTag: (key, tag) => ipcRenderer.invoke('lib-add-tag', { key, tag }),
    removeTag: (key, tag) => ipcRenderer.invoke('lib-remove-tag', { key, tag }),
    // v21：标签重命名 / 合并 / 全局移除
    renameTag: (from, to) => ipcRenderer.invoke('lib-rename-tag', { from, to }),
    mergeTags: (from, into) => ipcRenderer.invoke('lib-merge-tags', { from, into }),
    removeTagEverywhere: (tag) => ipcRenderer.invoke('lib-remove-tag-everywhere', { tag }),
    // v23：阅读笔记（一条文献挂多条笔记）
    addNote: (key, note) => ipcRenderer.invoke('lib-add-note', { key, note }),
    updateNote: (key, id, patch) => ipcRenderer.invoke('lib-update-note', { key, id, patch }),
    removeNote: (key, id) => ipcRenderer.invoke('lib-remove-note', { key, id }),
    // v9：按父条目元数据重命名附件文件（标注与全文索引随迁）
    renameFile: (keys) => ipcRenderer.invoke('lib-rename-file', { keys }),
    // v9：撤销 / 重做（快照式，覆盖删除、标签、收藏集、批量等）
    undo: () => ipcRenderer.invoke('lib-undo'),
    redo: () => ipcRenderer.invoke('lib-redo'),
    undoInfo: () => ipcRenderer.invoke('lib-undo-info'),
    onFilesRenamed: (cb) => { ipcRenderer.on('files-renamed', (_e, info) => cb(info)); },
    revealItem: (key) => ipcRenderer.invoke('lib-reveal-item', { key }),
    relinkItem: (key) => ipcRenderer.invoke('lib-relink-item', { key }),
    // v11：库级全文检索 / 备份 / 数据目录
    searchFull: (query) => ipcRenderer.invoke('lib-search-full', { query }),
    ftStatus: () => ipcRenderer.invoke('lib-ft-status'),
    indexAll: (force) => ipcRenderer.invoke('lib-ft-index', { force: !!force }),
    ftClear: () => ipcRenderer.invoke('lib-ft-clear'),
    backup: (outPath) => ipcRenderer.invoke('lib-backup', { outPath }),
    restore: (filePath) => ipcRenderer.invoke('lib-restore', { path: filePath }),
    chooseDataDir: (path, mode) => ipcRenderer.invoke('lib-choose-data-dir', { path, mode }),
    openDataDir: () => ipcRenderer.invoke('lib-open-data-dir'),
    // v12：元数据 / 文献格式 / 查重 / 批量 / 智能收藏集
    fetchMetadata: (identifier) => ipcRenderer.invoke('lib-fetch-metadata', { identifier }),
    // v9：抓 PDF 全文
    fetchPdf: (key, url) => ipcRenderer.invoke('lib-fetch-pdf', { key, url }),
    // 同时兼容 importRefs(text, name) 与 importRefs({ text, name })；
    // 无参调用表示“弹系统文件对话框”，由主进程判断。
    importRefs: (text, name) => ipcRenderer.invoke('lib-import-refs',
      (text && typeof text === 'object') ? text : { text, name }),
    exportRefs: (outPath) => ipcRenderer.invoke('lib-export-refs',
      (outPath && typeof outPath === 'object') ? outPath : { outPath }),
    duplicates: () => ipcRenderer.invoke('lib-duplicates'),
    mergeItems: (keepKey, otherKeys) => ipcRenderer.invoke('lib-merge-items', { keepKey, otherKeys }),
    bulkUpdate: (keys, patch) => ipcRenderer.invoke('lib-bulk-update', { keys, patch }),
    trashItems: (keys) => ipcRenderer.invoke('lib-trash-items', { keys }),
    addSearch: (name, query) => ipcRenderer.invoke('lib-add-search', { name, query }),
    removeSearch: (id) => ipcRenderer.invoke('lib-remove-search', { id }),
  },
});
