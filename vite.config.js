import { defineConfig } from 'vite'

// 多页应用：index.html = 浏览器预览/演示页（npm run dev 默认打开），
// pet.html = 桌宠窗口页面（Electron 加载）。
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        pet: 'pet.html',
        settings: 'settings.html'
      }
    }
  }
})
