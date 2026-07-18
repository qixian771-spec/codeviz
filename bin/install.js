#!/usr/bin/env node
/**
 * install.js - CodeViz 一键安装与 Claude 注册工具
 * 跨平台零依赖，动态匹配本地克隆路径，支持一键安装/卸载。
 * 用法:
 *   node bin/install.js          # 安装并注册至 ~/.claude/skills
 *   node bin/install.js --uninstall # 卸载已注册的 skill
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_UNINSTALL = process.argv.includes('--uninstall') || process.argv.includes('-u');

// 1. 定位 Claude 全局技能安装路径
const homeDir = os.homedir();
const claudeSkillsDir = path.join(homeDir, '.claude', 'skills');
const targetSkillDir = path.join(claudeSkillsDir, 'codeviz');
const targetSkillFile = path.join(targetSkillDir, 'SKILL.md');

// 本地的 SKILL.md 源文件与 bin/codeviz.js 入口路径
const localRoot = path.resolve(__dirname, '..');
const localSkillSource = path.join(localRoot, 'SKILL.md');
const localEntryScript = path.join(localRoot, 'bin', 'codeviz.js');

if (IS_UNINSTALL) {
  console.log('[codeviz] 正在清理已安装的 Claude Code 扩展...');
  try {
    if (fs.existsSync(targetSkillDir)) {
      fs.rmSync(targetSkillDir, { recursive: true, force: true });
      console.log('[codeviz] ✓ 已成功卸载并移除了 ~/.claude/skills/codeviz 目录');
    } else {
      console.log('[codeviz] 提示: 未检测到已安装的 CodeViz 技能。');
    }
  } catch (err) {
    console.error('[codeviz] ✕ 卸载过程中发生错误:', err.message);
  }
  process.exit(0);
}

console.log('[codeviz] 正在开始一键安装与注册工作...');

// 2. 核心校验
if (!fs.existsSync(localSkillSource)) {
  console.error('[codeviz] ✕ 错误: 未能在本地找到 SKILL.md 源文件: ' + localSkillSource);
  process.exit(1);
}
if (!fs.existsSync(localEntryScript)) {
  console.error('[codeviz] ✕ 错误: 未能在本地找到启动入口程序: ' + localEntryScript);
  process.exit(1);
}

try {
  // 3. 确保目录结构存在
  if (!fs.existsSync(claudeSkillsDir)) {
    fs.mkdirSync(claudeSkillsDir, { recursive: true });
  }
  if (!fs.existsSync(targetSkillDir)) {
    fs.mkdirSync(targetSkillDir, { recursive: true });
  }

  // 4. 读取本地 SKILL.md 并动态替换 action 路径
  let skillContent = fs.readFileSync(localSkillSource, 'utf-8');

  // 当前入口脚本的正斜杠路径（跨平台兼容）
  const entryPath = localEntryScript.replace(/\\/g, '/');
  const newAction = 'action: "node ' + entryPath + '"';

  // 匹配 action: "node .../bin/codeviz.js" 或 action: 'node .../bin/codeviz.js'
  const actionRegex = /action:\s*["']node\s+[^"']*\/bin\/codeviz\.js["']/i;

  if (actionRegex.test(skillContent)) {
    skillContent = skillContent.replace(actionRegex, newAction);
    console.log('[codeviz] ✓ 已动态替换 action 路径');
  } else {
    // 如果 SKILL.md 里没有 action 行（不应该发生），警告但继续
    console.warn('[codeviz] 警告: 未在 SKILL.md 中匹配到 action 路径，跳过替换');
  }

  // 5. 写入目标文件
  fs.writeFileSync(targetSkillFile, skillContent, 'utf-8');
  console.log('[codeviz] ✓ 技能描述文件已成功写入: ' + targetSkillFile);
  console.log('[codeviz]   本地动态匹配的启动路径: ' + localEntryScript);

  console.log('\n[codeviz] ⚡ 安装成功！');
  console.log('现在你可以直接在 Claude Code 终端中输入以下任意内容来开启可视化：');
  console.log('  👉 /codeviz');
  console.log('  👉 开始可视化 / 打开导图');
  console.log('\n卸载请输入: node bin/install.js --uninstall\n');
} catch (err) {
  console.error('[codeviz] ✕ 安装失败，错误信息:', err.message);
  process.exit(1);
}
