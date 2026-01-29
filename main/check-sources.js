const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const inputJsonPath = path.join(path.dirname(__dirname), 'output.json');
const outputJsonPath = path.join(path.dirname(__dirname), 'output.json');

const TIMEOUT = 5000;
const MAX_CONCURRENT = 10;

function isValidProtocol(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function checkUrl(url) {
  if (!isValidProtocol(url)) {
    return Promise.resolve(false);
  }
  
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;
    const startTime = Date.now();
    
    const req = protocol.request(url, { 
      method: 'HEAD',
      timeout: TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      const isValid = res.statusCode >= 200 && res.statusCode < 400;
      resolve(isValid);
      req.destroy();
    });
    
    req.on('error', () => {
      resolve(false);
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    
    req.setTimeout(TIMEOUT);
    req.end();
  });
}

async function checkSources(sources) {
  const validSources = [];
  const total = sources.length;
  let checked = 0;
  
  for (let i = 0; i < sources.length; i += MAX_CONCURRENT) {
    const batch = sources.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(batch.map(async (url) => {
      const isValid = await checkUrl(url);
      checked++;
      if (checked % 20 === 0 || checked === total) {
        process.stdout.write(`\r检查进度: ${checked}/${total} (${Math.round(checked/total*100)}%)`);
      }
      return { url, isValid };
    }));
    
    results.forEach(({ url, isValid }) => {
      if (isValid) {
        validSources.push(url);
      }
    });
  }
  
  process.stdout.write('\n');
  return validSources;
}

async function processChannels(channels) {
  const result = [];
  const totalChannels = channels.length;
  
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    console.log(`\n检查频道: ${channel.name} (${channel.sources.length} 个源)`);
    
    const validSources = await checkSources(channel.sources);
    console.log(`  有效源: ${validSources.length}/${channel.sources.length}`);
    
    if (validSources.length > 0) {
      result.push({
        name: channel.name,
        sources: validSources
      });
    }
    
    process.stdout.write(`频道进度: ${i + 1}/${totalChannels}\n`);
  }
  
  return result;
}

async function processCategory(category) {
  const result = {};
  
  for (const [key, channels] of Object.entries(category)) {
    if (Array.isArray(channels) && channels.length > 0) {
      console.log(`\n处理分类: ${key}`);
      result[key] = await processChannels(channels);
    } else {
      result[key] = channels;
    }
  }
  
  return result;
}

async function main() {
  try {
    console.log('读取频道文件...');
    const data = JSON.parse(fs.readFileSync(inputJsonPath, 'utf8'));
    
    console.log('\n开始检查频道源...\n');
    console.log('='.repeat(50));
    
    const result = {};
    
    if (data.cctv_channels) {
      console.log('\n处理央视频道...');
      result.cctv_channels = await processCategory(data.cctv_channels);
    }
    
    if (data.provincial_satellite_channel) {
      console.log('\n处理省级卫视...');
      result.provincial_satellite_channel = await processCategory(data.provincial_satellite_channel);
    }
    
    if (data.digital_paid_channel) {
      console.log('\n处理数字付费频道...');
      result.digital_paid_channel = await processChannels(data.digital_paid_channel);
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('\n写入输出文件...');
    fs.writeFileSync(outputJsonPath, JSON.stringify(result, null, 2), 'utf8');
    
    console.log('\n完成！结果已保存到', outputJsonPath);
    
    const totalChannels = 
      (result.cctv_channels?.free_terrestrial_channel?.length || 0) +
      (result.cctv_channels?.donghua_region?.length || 0) +
      (result.provincial_satellite_channel?.huabei_region?.length || 0) +
      (result.provincial_satellite_channel?.dongbei_region?.length || 0) +
      (result.provincial_satellite_channel?.huadong_region?.length || 0) +
      (result.provincial_satellite_channel?.zhongnan_region?.length || 0) +
      (result.provincial_satellite_channel?.xinan_region?.length || 0) +
      (result.provincial_satellite_channel?.xibei_region?.length || 0) +
      (result.provincial_satellite_channel?.characteristic_city_channel?.length || 0) +
      (result.digital_paid_channel?.length || 0);
    
    console.log(`\n统计: 共 ${totalChannels} 个频道`);
    
  } catch (err) {
    console.error('\n错误:', err);
    process.exit(1);
  }
}

main();
