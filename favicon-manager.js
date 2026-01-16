/**
 * FaviconManager
 * 负责网站图标的获取、缓存、备份和优化
 * 
 * 功能：
 * 1. 多源获取：Favicon.im (主) -> Favicon Grabber (备)
 * 2. 本地缓存：IndexedDB (7天有效期)
 * 3. 性能优化：并发控制、图片压缩
 * 4. 容错处理：自动重试、错误日志
 */

const DB_NAME = 'FaviconDB';
const DB_VERSION = 1;
const STORE_NAME = 'icons';
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CONCURRENT = 10;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 5000; // 5 seconds timeout

class FaviconManager {
  constructor() {
    this.db = null;
    this.queue = [];
    this.processing = 0;
    this.memoryCache = new Map(); // 短期内存缓存
    this.readyPromise = this.initDB();
    this.pendingRequests = new Map(); // 避免重复请求同一个域名
  }

  // 初始化 IndexedDB
  initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = (event) => {
        console.error('[FaviconManager] DB Error:', event.target.error);
        resolve(); // 即使失败也 resolve，降级为无缓存模式
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'domain' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('[FaviconManager] DB Initialized');
        resolve();
      };
    });
  }

  // 获取图标的主入口
  async get(domain) {
    if (!domain) return null;
    
    // 1. 检查内存缓存
    if (this.memoryCache.has(domain)) {
      return this.memoryCache.get(domain);
    }

    await this.readyPromise;

    // 2. 检查 IndexedDB
    if (this.db) {
      try {
        const cached = await this.getFromDB(domain);
        if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
          // 命中且有效
          const url = this.createURL(cached);
          this.memoryCache.set(domain, url);
          return url;
        }
      } catch (err) {
        console.warn('[FaviconManager] DB Read Error:', err);
      }
    }

    // 3. 加入下载队列
    // 如果已经在请求中，返回同一个 Promise
    if (this.pendingRequests.has(domain)) {
      return this.pendingRequests.get(domain);
    }

    const promise = new Promise((resolve, reject) => {
      this.queue.push({ domain, resolve, reject });
      this.processQueue();
    });

    this.pendingRequests.set(domain, promise);
    
    // 请求完成后清理 pending 标记
    promise.finally(() => {
      this.pendingRequests.delete(domain);
    });

    return promise;
  }

  // 从 DB 获取数据
  getFromDB(domain) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject('DB not ready');
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(domain);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // 存入 DB
  putToDB(data) {
    if (!this.db) return;
    const transaction = this.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(data);
  }

  // 根据缓存数据创建 URL
  createURL(data) {
    if (data.type === 'blob') {
      return URL.createObjectURL(data.data);
    } else {
      return data.data; // URL string
    }
  }

  // 处理队列
  async processQueue() {
    if (this.processing >= MAX_CONCURRENT || this.queue.length === 0) return;

    const task = this.queue.shift();
    this.processing++;

    try {
      const result = await this.fetchIcon(task.domain);
      // 存入缓存
      this.putToDB({
        domain: task.domain,
        data: result.data,
        type: result.type,
        timestamp: Date.now(),
        source: result.source
      });
      
      const url = result.type === 'blob' ? URL.createObjectURL(result.data) : result.data;
      this.memoryCache.set(task.domain, url);
      task.resolve(url);
    } catch (error) {
      console.error(`[FaviconManager] Failed to load icon for ${task.domain}:`, error);
      // 失败返回默认或 null，由 UI 处理
      task.resolve(null); 
    } finally {
      this.processing--;
      this.processQueue(); // 继续处理下一个
    }
  }

  // 核心获取逻辑：主源 -> 备源
  async fetchIcon(domain) {
    // 尝试主源 Favicon.im
    try {
      return await this.fetchFromPrimary(domain);
    } catch (err) {
      console.warn(`[FaviconManager] Primary source failed for ${domain}:`, err);
      // 尝试备源 Favicon Grabber
      try {
        return await this.fetchFromBackup(domain);
      } catch (backupErr) {
        console.error(`[FaviconManager] All sources failed for ${domain}`);
        throw backupErr;
      }
    }
  }

  // 主源：Favicon.im
  async fetchFromPrimary(domain) {
    const url = `https://favicon.im/${domain}`;
    return await this.fetchAndProcess(url, 'favicon.im', domain);
  }

  // 备源：Favicon Grabber
  async fetchFromBackup(domain) {
    const apiUrl = `https://api.favicongrabber.com/api/grab/${domain}`;
    // 获取 JSON
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`Backup API status: ${response.status}`);
    
    const data = await response.json();
    if (!data.icons || data.icons.length === 0) throw new Error('No icons found in backup');

    // 挑选最佳图标 (优先 PNG, 优先 64px 左右)
    // 简单逻辑：找第一个 src
    const icon = data.icons.find(i => i.src) || data.icons[0];
    return await this.fetchAndProcess(icon.src, 'favicongrabber', domain);
  }

  // 通用下载和处理函数
  async fetchAndProcess(url, source, domain) {
    let retries = 0;
    while (retries <= MAX_RETRIES) {
      try {
        // 尝试 CORS 请求，带超时控制
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        
        try {
          const response = await fetch(url, { 
            mode: 'cors',
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          
          // 如果成功且是图片
          if (response.ok) {
              const blob = await response.blob();
              // 校验格式
              if (!blob.type.startsWith('image/')) {
                  throw new Error('Invalid content type');
              }
              // 压缩
              const compressed = await this.compressImage(blob);
              return { type: 'blob', data: compressed, source };
          } else {
               throw new Error(`HTTP ${response.status}`);
          }
        } catch (fetchErr) {
          clearTimeout(timeoutId);
          throw fetchErr;
        }
      } catch (err) {
        // 如果是 CORS 错误 (TypeError) 或其他网络错误
        // 对于主源 favicon.im，如果 fetch 失败（可能是 CORS），我们降级为存储 URL
        if (source === 'favicon.im' && retries === MAX_RETRIES) {
            // 最后的尝试：如果我们无法获取 Blob，但这是一个图片 URL，
            // 我们返回 URL 类型，让 <img> 标签直接加载
             console.log(`[FaviconManager] Fallback to URL mode for ${domain} due to CORS/Network`);
             return { type: 'url', data: url, source: source + '-fallback' };
        }
        
        retries++;
        if (retries > MAX_RETRIES) throw err;
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, retries))); // 指数退避
      }
    }
  }

  // 图片压缩优化
  async compressImage(blob) {
    // 如果不是图片或已经是小文件，直接返回
    if (blob.size < 5120) return blob; // < 5KB

    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      
      img.onload = () => {
        URL.revokeObjectURL(url);
        // 如果图片本身很小，不需要压缩
        if (img.width <= 64 && img.height <= 64) {
             resolve(blob);
             return;
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 64;
        canvas.height = 64;
        
        // 绘制并调整大小
        ctx.drawImage(img, 0, 0, 64, 64);
        
        // 导出
        canvas.toBlob((newBlob) => {
            resolve(newBlob || blob);
        }, 'image/png', 0.8);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(blob); // 压缩失败返回原图
      };

      img.src = url;
    });
  }
}

// 导出全局实例
window.FaviconManager = new FaviconManager();
