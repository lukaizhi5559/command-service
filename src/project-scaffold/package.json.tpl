{
  "name": "{{PROJECT_NAME}}",
  "version": "1.0.0",
  "private": true,
  "description": "{{PROJECT_DESCRIPTION}}",
  "scripts": {
    "dev": "concurrently \"node server/index.js\" \"vite\"",
    "build": "vite build",
    "start": "node server/index.js",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "express": "^4.18.0",
    "express-ws": "^5.0.2",
    "@nut-tree-fork/nut-js": "^4.2.6",
    "lucide-react": "^0.263.0",
    "@radix-ui/react-slot": "^1.0.0",
    "@radix-ui/react-scroll-area": "^1.0.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.0.0",
    "tailwind-merge": "^2.0.0",
    "tailwindcss-animate": "^1.0.7"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^5.0.0",
    "tailwindcss": "^3.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "concurrently": "^8.0.0"
  }
}
