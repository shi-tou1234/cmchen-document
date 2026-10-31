'use strict';
/*
 * 关窗时的两个提示框文案（v1.6f）。
 *
 * 单独成模块是为了能被 Node 直接回归——main.js 一 require 就会拉起 Electron，
 * 里面的对话框分支没法在单测里走。
 *
 * 唯一不能破的约束：**永远保留「继续等待」**，并且 Esc / 关闭按钮（cancelId）指向它。
 * 之前第三轮把按钮收成只剩「仍然关闭」、cancelId 仍是 0，按 Esc 就等于放弃未完成的保存——
 * 用户以为自己在取消弹窗，实际是同意丢改动（R-v1.6f-02）。
 */
const WAIT_MS = 4000;

// 保存迟迟没完成：继续等，还是明确放弃
function waitPrompt(rounds) {
  const n = Math.max(1, Math.round(Number(rounds) || 1));
  return {
    type: 'warning',
    buttons: ['继续等待', '仍然关闭（这次改动可能丢失）'],
    defaultId: 0,
    cancelId: 0,          // Esc / 关闭 = 继续等待，绝不能是「放弃」
    title: '保存还没完成',
    message: '关闭前正在保存改动，已经等了约 ' + (n * (WAIT_MS / 1000)) + ' 秒还没完成。',
    detail: '选「继续等待」会再等 ' + (WAIT_MS / 1000) + ' 秒；选「仍然关闭」则这次改动可能丢失。',
  };
}

// 保存明确失败：仍然关闭（丢改动）还是回去处理
function saveFailedPrompt(error) {
  return {
    type: 'warning',
    buttons: ['仍然关闭（这次改动会丢）', '返回处理'],
    defaultId: 1,
    cancelId: 1,          // Esc / 关闭 = 返回处理
    title: '标注没有保存',
    message: '关闭前保存失败，这次改动还没写到磁盘。',
    detail: String(error || '请检查磁盘空间或目录权限后重试。'),
  };
}

module.exports = { waitPrompt, saveFailedPrompt, WAIT_MS };
