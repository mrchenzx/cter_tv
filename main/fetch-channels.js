const https = require('https');
const http = require('http');
const fs = require('fs');
const fsPromises = fs.promises;
const readline = require('readline');
const path = require('path');

// 路径配置（移除 completedFlagPath 定义）
const channelJsonPath = path.join(__dirname, 'channel.json');
const outputJsonPath = path.join(path.dirname(__dirname), 'output.json');
const tempDir = path.join(path.dirname(__dirname), 'temp_subscriptions');
const progressJsonPath = path.join(path.dirname(__dirname), 'progress.json');

// 配置常量
const MAX_CHANNELS_PER_RUN = 5; // 每次运行最多处理5个频道
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 单个响应最大10MB
const TEMP_FILE_FLAG = path.join(tempDir, '.download_complete'); // 标记临时文件已下载

/**
 * 检查是否为IPv6地址
 */
function isIPv6(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    return hostname.includes(':') || hostname.startsWith('[');
  } catch (e) {
    return false;
  }
}

/**
 * 流式下载URL内容（限制大小）
 * 优化：增加User-Agent，适配部分反爬服务器
 */
async function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const options = {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    };
    const protocol = url.startsWith('https') ? https : http;
    let receivedSize = 0;
    const chunks = [];

    const req = protocol.get(url, options, (res) => {
      res.on('data', (chunk) => {
        receivedSize += chunk.length;
        if (receivedSize > MAX_RESPONSE_SIZE) {
          req.destroy(new Error(`Response size exceeds ${MAX_RESPONSE_SIZE / 1024 / 1024}MB limit`));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });

      res.on('error', (err) => reject(err));
    }).on('error', (err) => reject(err));

    // 设置超时
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timeout after 30s'));
    });
  });
}

/**
 * 检测文件格式（m3u/txt）
 */
function detectFormat(content) {
  const trimmed = content.trim();
  return trimmed.startsWith('#EXTM3U') ? 'm3u' : 'txt';
}

/**
 * 解析M3U文件，返回频道-URL映射
 */
async function parseM3U(filePath) {
  try {
    const content = await fsPromises.readFile(filePath, 'utf8');
    const channels = {};
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXTINF')) {
        const nextLine = lines[i + 1] ? lines[i + 1].trim() : '';
        if (nextLine && !nextLine.startsWith('#')) {
          let channelName = '';
          const tvgNameMatch = line.match(/tvg-name="([^"]+)"/);
          const commaMatch = line.match(/,([^,]+)$/);
          
          if (tvgNameMatch) channelName = tvgNameMatch[1];
          else if (commaMatch) channelName = commaMatch[1].trim();
          
          if (channelName && nextLine && !isIPv6(nextLine)) {
            if (!channels[channelName]) channels[channelName] = [];
            channels[channelName].push(nextLine);
          }
        }
      }
    }
    return channels;
  } catch (err) {
    console.error(`解析M3U失败: ${filePath} - ${err.message}`);
    return {};
  }
}

/**
 * 解析TXT文件，返回频道-URL映射
 */
async function parseTXT(filePath) {
  try {
    const content = await fsPromises.readFile(filePath, 'utf8');
    const channels = {};
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.includes(',') && !trimmedLine.startsWith('#')) {
        const parts = trimmedLine.split(',');
        if (parts.length >= 2) {
          const channelName = parts[0].trim();
          const url = parts.slice(1).join(',').trim();
          
          if (channelName && url && url.startsWith('http') && !isIPv6(url)) {
            if (!channels[channelName]) channels[channelName] = [];
            channels[channelName].push(url);
          }
        }
      }
    }
    return channels;
  } catch (err) {
    console.error(`解析TXT失败: ${filePath} - ${err.message}`);
    return {};
  }
}

/**
 * 完全匹配频道名称（用户修改后的逻辑，重命名函数避免混淆）
 */
function exactMatch(channelName, targetNames) {
  const normalizedChannel = channelName.toLowerCase().replace(/[\s\-_]/g, '');
  
  for (const targetName of targetNames) {
    const normalizedTarget = targetName.toLowerCase().replace(/[\s\-_]/g, '');
    
    if (normalizedChannel === normalizedTarget) {
      return true;
    }
  }
  
  return false;
}

/**
 * 生成扩展的匹配名称（避免数组无限膨胀）
 */
function getExpandedNames(baseNames) {
  const expanded = new Set([...baseNames]); // 去重
  
  for (const name of baseNames) {
    const numberMatch = name.match(/(\d+)/);
    if (numberMatch) {
      const num = numberMatch[1];
      expanded.add(name.replace(num, `-${num}`));
      expanded.add(name.replace(num, num)); // 冗余但保留原有逻辑
    }
  }
  
  return [...expanded].slice(0, 50); // 限制最大数量，防止内存溢出
}

/**
 * 创建进度配置文件
 */
function createProgressConfig(allChannels, tempFiles) {
  const progress = {};
  
  for (const channel of allChannels) {
    const channelKey = Array.isArray(channel.name) ? channel.name[0] : channel.name;
    progress[channelKey] = {
      name: channel.name,
      pendingFiles: [...tempFiles],
      processed: false
    };
  }
  
  return progress;
}

/**
 * 保存进度配置（覆盖写入）
 */
async function saveProgress(progress) {
  await fsPromises.writeFile(progressJsonPath, JSON.stringify(progress, null, 2), 'utf8');
}

/**
 * 加载进度配置
 */
async function loadProgress() {
  try {
    await fsPromises.access(progressJsonPath);
    const content = await fsPromises.readFile(progressJsonPath, 'utf8');
    return JSON.parse(content) || {};
  } catch (e) {
    return null;
  }
}

/**
 * 加载输出文件（不存在则创建空结构）
 */
async function loadOutput() {
  try {
    await fsPromises.access(outputJsonPath);
    const content = await fsPromises.readFile(outputJsonPath, 'utf8');
    return JSON.parse(content) || {
      cctv_channels: { free_terrestrial_channel: [], donghua_region: [] },
      provincial_satellite_channel: {
        huabei_region: [], dongbei_region: [], huadong_region: [],
        zhongnan_region: [], xinan_region: [], xibei_region: [],
        characteristic_city_channel: []
      },
      digital_paid_channel: []
    };
  } catch (e) {
    return {
      cctv_channels: { free_terrestrial_channel: [], donghua_region: [] },
      provincial_satellite_channel: {
        huabei_region: [], dongbei_region: [], huadong_region: [],
        zhongnan_region: [], xinan_region: [], xibei_region: [],
        characteristic_city_channel: []
      },
      digital_paid_channel: []
    };
  }
}

/**
 * 保存输出文件（去重追加）
 */
async function saveOutput(output) {
  await fsPromises.writeFile(outputJsonPath, JSON.stringify(output, null, 2), 'utf8');
}

/**
 * 检查频道是否已存在于output中（去重）
 */
function isChannelInOutput(output, channelName, channelData) {
  const nameKey = Array.isArray(channelName) ? channelName[0] : channelName;
  
  // 检查CCTV频道
  if (output.cctv_channels.free_terrestrial_channel.some(item => {
    const itemKey = Array.isArray(item.name) ? item.name[0] : item.name;
    return itemKey === nameKey;
  })) return true;
  
  if (output.cctv_channels.donghua_region.some(item => {
    const itemKey = Array.isArray(item.name) ? item.name[0] : item.name;
    return itemKey === nameKey;
  })) return true;
  
  // 检查省级卫视
  const provincialRegions = [
    'huabei_region', 'dongbei_region', 'huadong_region',
    'zhongnan_region', 'xinan_region', 'xibei_region', 'characteristic_city_channel'
  ];
  
  for (const region of provincialRegions) {
    if (output.provincial_satellite_channel[region].some(item => {
      const itemKey = Array.isArray(item.name) ? item.name[0] : item.name;
      return itemKey === nameKey;
    })) return true;
  }
  
  // 检查付费频道
  if (output.digital_paid_channel.some(item => {
    const itemKey = Array.isArray(item.name) ? item.name[0] : item.name;
    return itemKey === nameKey;
  })) return true;
  
  return false;
}

/**
 * 处理单个频道（核心逻辑）
 */
async function processSingleChannel(channelKey, channelProgress, channelData) {
  console.log(`\n🔍 处理频道: ${JSON.stringify(channelProgress.name)}`);
  console.log(`📁 待处理文件数: ${channelProgress.pendingFiles.length}`);
  
  const matchedSources = new Set();
  const possibleNames = getExpandedNames(Array.isArray(channelProgress.name) ? channelProgress.name : [channelProgress.name]);
  
  // 遍历所有待处理文件
  for (const filePath of channelProgress.pendingFiles) {
    try {
      // 检查文件是否存在
      await fsPromises.access(filePath);
      const content = await fsPromises.readFile(filePath, 'utf8');
      const format = detectFormat(content);
      
      // 解析文件
      const fileChannels = format === 'm3u' ? await parseM3U(filePath) : await parseTXT(filePath);
      
      // 匹配频道源（改用完全匹配）
      for (const [fileChannelName, urls] of Object.entries(fileChannels)) {
        if (exactMatch(fileChannelName, possibleNames)) {
          urls.forEach(url => {
            if (url && !isIPv6(url)) matchedSources.add(url);
          });
        }
      }
      
      console.log(`  ✅ 已处理文件: ${path.basename(filePath)}`);
    } catch (err) {
      console.log(`  ❌ 文件处理失败: ${path.basename(filePath)} - ${err.message}`);
    }
  }
  
  // 返回匹配结果（去重）
  const sourcesArray = [...matchedSources].slice(0, 100); // 限制每个频道的源数量
  return sourcesArray.length > 0 ? {
    name: channelProgress.name,
    sources: sourcesArray
  } : null;
}

/**
 * 获取频道在channelData中的分类
 */
function getChannelCategory(channelName, channelData) {
  const nameKey = Array.isArray(channelName) ? channelName[0] : channelName;
  
  // 辅助函数：按名称匹配频道
  const matchChannel = (channelList) => {
    if (!channelList) return false;
    return channelList.some(chan => {
      const chanKey = Array.isArray(chan.name) ? chan.name[0] : chan.name;
      return chanKey === nameKey;
    });
  };
  
  // 检查分类
  if (matchChannel(channelData.cctv_channels?.free_terrestrial_channel)) {
    return { type: 'cctv', subType: 'free_terrestrial_channel' };
  } else if (matchChannel(channelData.cctv_channels?.donghua_region)) {
    return { type: 'cctv', subType: 'donghua_region' };
  } else if (matchChannel(channelData.provincial_satellite_channel?.huabei_region)) {
    return { type: 'provincial', subType: 'huabei_region' };
  } else if (matchChannel(channelData.provincial_satellite_channel?.dongbei_region)) {
    return { type: 'provincial', subType: 'dongbei_region' };
  } else if (matchChannel(channelData.provincial_satellite_channel?.huadong_region)) {
    return { type: 'provincial', subType: 'huadong_region' };
  } else if (matchChannel(channelData.provincial_satellite_channel?.zhongnan_region)) {
    return { type: 'provincial', subType: 'zhongnan_region' };
  } else if (matchChannel(channelData.provincial_satellite_channel?.xinan_region)) {
    return { type: 'provincial', subType: 'xinan_region' };
  } else if (matchChannel(channelData.provincial_satellite_channel?.xibei_region)) {
    return { type: 'provincial', subType: 'xibei_region' };
  } else if (matchChannel(channelData.provincial_satellite_channel?.characteristic_city_channel)) {
    return { type: 'provincial', subType: 'characteristic_city_channel' };
  } else if (matchChannel(channelData.digital_paid_channel)) {
    return { type: 'digital_paid' };
  }
  
  return null;
}

/**
 * 下载订阅文件（仅首次运行下载）
 * 优化：增加GitHub Actions权限容错
 */
async function downloadSubscriptions(subscriptionUrls) {
  // 检查是否已下载过
  if (await fsPromises.access(TEMP_FILE_FLAG).then(() => true).catch(() => false)) {
    console.log('✅ 订阅文件已下载，跳过下载步骤');
    // 读取已有的临时文件
    const tempFiles = [];
    try {
      const files = await fsPromises.readdir(tempDir);
      for (const file of files) {
        if (file.startsWith('sub_') && file.endsWith('.txt')) {
          tempFiles.push(path.join(tempDir, file));
        }
      }
    } catch (err) {
      console.error(`读取临时文件失败: ${err.message}`);
      return [];
    }
    return tempFiles;
  }
  
  // 开始下载
  console.log('📥 下载订阅内容到临时文件...');
  const tempFiles = [];
  
  for (let i = 0; i < subscriptionUrls.length; i++) {
    const url = subscriptionUrls[i];
    console.log(`  正在下载: ${url}`);
    try {
      const content = await fetchUrl(url);
      const tempFilePath = path.join(tempDir, `sub_${i}.txt`);
      await fsPromises.writeFile(tempFilePath, content, 'utf8');
      tempFiles.push(tempFilePath);
      console.log(`  ✅ 已保存到 ${path.basename(tempFilePath)}`);
    } catch (err) {
      console.error(`  ❌ 下载失败: ${url} - ${err.message}`);
    }
  }
  
  // 创建下载完成标记
  try {
    await fsPromises.writeFile(TEMP_FILE_FLAG, JSON.stringify({ downloaded: new Date().toISOString() }), 'utf8');
  } catch (err) {
    console.warn(`创建下载标记失败: ${err.message}`);
  }
  return tempFiles;
}

/**
 * 处理一批频道（单次5个）
 */
async function processBatchChannels(channelData, tempFiles) {
  // 1. 加载最新进度配置
  let progress = await loadProgress();
  if (!progress) {
    console.error('❌ 进度配置文件不存在，无法处理批量频道');
    return false;
  }

  // 2. 获取待处理频道（未处理的块）
  const pendingChannelKeys = Object.keys(progress).filter(key => !progress[key].processed);
  console.log(`\n📊 当前待处理频道总数: ${pendingChannelKeys.length}`);
  
  // 3. 无待处理频道，返回完成状态
  if (pendingChannelKeys.length === 0) {
    return true;
  }

  // 4. 取前5个待处理频道（不足5个则取剩余全部）
  const channelsToProcessKeys = pendingChannelKeys.slice(0, MAX_CHANNELS_PER_RUN);
  console.log(`🔄 本次处理频道数: ${channelsToProcessKeys.length}`);

  // 5. 加载输出文件，准备批量更新
  const output = await loadOutput();
  let successAddedCount = 0; // 统计本次成功添加的频道数

  // 6. 循环处理本次的频道
  for (const channelKey of channelsToProcessKeys) {
    const channelProgress = progress[channelKey];
    console.log('\n' + '-'.repeat(60));
    
    // 处理单个频道
    const channelResult = await processSingleChannel(channelKey, channelProgress, channelData);

    // 处理匹配结果，添加到output
    if (channelResult && !isChannelInOutput(output, channelResult.name, channelData)) {
      // 获取频道分类
      const category = getChannelCategory(channelResult.name, channelData);
      if (category) {
        // 添加到对应分类
        if (category.type === 'cctv') {
          output.cctv_channels[category.subType].push(channelResult);
        } else if (category.type === 'provincial') {
          output.provincial_satellite_channel[category.subType].push(channelResult);
        } else if (category.type === 'digital_paid') {
          output.digital_paid_channel.push(channelResult);
        }
        successAddedCount++;
        console.log(`✅ 【${channelKey}】匹配成功，已加入输出队列`);
      } else {
        console.log(`⚠️ 【${channelKey}】未找到对应分类，跳过`);
      }
    } else if (!channelResult) {
      console.log(`⚠️ 【${channelKey}】未匹配到任何源，跳过`);
    } else {
      console.log(`⚠️ 【${channelKey}】已存在于输出文件，跳过`);
    }

    // 从进度文件中删除当前处理完的频道块
    delete progress[channelKey];
  }

  // 7. 保存更新后的进度配置
  await saveProgress(progress);
  console.log(`\n✅ 进度配置已更新: ${progressJsonPath}`);

  // 8. 批量保存更新后的输出文件
  if (successAddedCount > 0) {
    await saveOutput(output);
    console.log(`✅ 本次共成功添加 ${successAddedCount} 个频道，输出文件已更新: ${outputJsonPath}`);
  } else {
    console.log(`ℹ️  本次无新频道添加到输出文件`);
  }

  // 9. 提示剩余频道
  const remaining = Object.keys(progress).length;
  console.log(`\n📋 剩余待处理频道数: ${remaining}`);

  return false; // 未完成所有处理
}

/**
 * 主函数（核心修改：移除.completed检测，每次都完整执行）
 */
async function main() {
  try {
    // 1. 初始化目录（增加权限容错）
    try {
      if (!fs.existsSync(tempDir)) {
        await fsPromises.mkdir(tempDir, { recursive: true, mode: 0o755 });
      }
    } catch (err) {
      console.error(`创建临时目录失败: ${err.message}`);
      process.exit(1);
    }

    // 2. 读取频道配置
    console.log('📄 读取频道配置文件...');
    let channelData;
    try {
      const channelContent = await fsPromises.readFile(channelJsonPath, 'utf8');
      channelData = JSON.parse(channelContent);
    } catch (err) {
      console.error(`读取频道配置失败: ${err.message}`);
      process.exit(1);
    }
    
    // 3. 处理订阅URL
    let subscriptionUrls = channelData.subscription_urls || [];
    if (subscriptionUrls.length === 0) {
      console.log('⚠️ 未找到订阅地址，程序退出');
      process.exit(0);
    }
    if (typeof subscriptionUrls[0] === 'object' && subscriptionUrls[0].url) {
      subscriptionUrls = subscriptionUrls.map(item => item.url);
    }

    // 4. 下载订阅文件（仅首次）
    const tempFiles = await downloadSubscriptions(subscriptionUrls);
    if (tempFiles.length === 0 && !await fsPromises.access(TEMP_FILE_FLAG).then(() => true).catch(() => false)) {
      console.error('❌ 订阅文件下载失败且无历史文件，程序退出');
      process.exit(1);
    }

    // 5. 收集所有频道（去重）
    const allChannels = [];
    const channelSet = new Set();
    
    // 辅助函数：添加频道（去重）
    const addChannels = (channels) => {
      if (!channels) return;
      for (const channel of channels) {
        const key = Array.isArray(channel.name) ? channel.name[0] : channel.name;
        if (!channelSet.has(key)) {
          channelSet.add(key);
          allChannels.push(channel);
        }
      }
    };
    
    // 收集所有频道
    addChannels(channelData.cctv_channels?.free_terrestrial_channel);
    addChannels(channelData.cctv_channels?.donghua_region);
    addChannels(channelData.provincial_satellite_channel?.huabei_region);
    addChannels(channelData.provincial_satellite_channel?.dongbei_region);
    addChannels(channelData.provincial_satellite_channel?.huadong_region);
    addChannels(channelData.provincial_satellite_channel?.zhongnan_region);
    addChannels(channelData.provincial_satellite_channel?.xinan_region);
    addChannels(channelData.provincial_satellite_channel?.xibei_region);
    addChannels(channelData.provincial_satellite_channel?.characteristic_city_channel);
    addChannels(channelData.digital_paid_channel);

    // 6. 初始化进度配置（首次运行）
    let progress = await loadProgress();
    if (!progress) {
      progress = createProgressConfig(allChannels, tempFiles);
      await saveProgress(progress);
      console.log(`✅ 已创建进度配置文件: ${progressJsonPath}`);
    }

    // 7. 核心修改：循环处理批次，直到所有频道完成
    console.log('\n🚀 开始循环处理所有频道批次...');
    let isAllCompleted = false;
    while (!isAllCompleted) {
      // 处理一批频道（5个），返回是否全部完成
      isAllCompleted = await processBatchChannels(channelData, tempFiles);
      
      // 如果未完成，提示并进入下一轮循环
      if (!isAllCompleted) {
        console.log('\n🔄 准备处理下一批频道...');
      }
    }

    // 8. 所有频道处理完成（仅提示，不创建标记/删除文件）
    console.log('\n🎉 所有频道处理完成！');
    console.log('ℹ️  下次运行将重新初始化进度并再次处理所有频道');

    console.log('\n' + '='.repeat(60));
    console.log('✅ 全部处理流程完成！');

  } catch (err) {
    console.error('\n❌ 程序执行错误:', err);
    process.exit(1);
  }
}

// 启动程序
main();
