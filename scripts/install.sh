#!/bin/bash

# ============================================
# Trading Terminal 服务器安装脚本
# 适用于: CentOS / OpenCloudOS / RHEL
# ============================================

set -e

echo "=========================================="
echo "Trading Terminal 安装脚本"
echo "=========================================="

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# 检查是否为 root 用户
if [ "$EUID" -ne 0 ]; then
    print_error "请使用 root 用户运行此脚本"
    print_warning "使用: sudo bash install.sh"
    exit 1
fi

# ============================================
# 1. 系统更新
# ============================================
echo ""
echo ">>> 更新系统包..."
yum update -y
print_status "系统更新完成"

# ============================================
# 2. 安装基础工具
# ============================================
echo ""
echo ">>> 安装基础工具..."
yum install -y git curl wget gcc gcc-c++ make openssl-devel
print_status "基础工具安装完成"

# ============================================
# 3. 安装 Node.js 18
# ============================================
echo ""
echo ">>> 安装 Node.js 18..."

if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    print_warning "Node.js 已安装: $NODE_VERSION"
else
    # 尝试使用 dnf module (适用于 OpenCloudOS/CentOS 9)
    if dnf module list nodejs 2>/dev/null | grep -q "18"; then
        dnf module reset nodejs -y 2>/dev/null || true
        dnf module enable nodejs:18 -y
        dnf install nodejs -y
    else
        # 使用二进制包安装
        print_warning "使用二进制包安装 Node.js..."
        NODE_VERSION="v18.19.0"
        NODE_DISTRO="linux-x64"
        cd /tmp
        curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${NODE_DISTRO}.tar.xz" -o node.tar.xz
        tar -xJf node.tar.xz
        cp -r node-${NODE_VERSION}-${NODE_DISTRO}/{bin,lib,share} /usr/local/
        rm -rf node.tar.xz node-${NODE_VERSION}-${NODE_DISTRO}
        cd -
    fi
    print_status "Node.js 安装完成: $(node -v)"
fi

# 安装 PM2
echo ""
echo ">>> 安装 PM2..."
if command -v pm2 &> /dev/null; then
    print_warning "PM2 已安装"
else
    npm install -g pm2
    print_status "PM2 安装完成"
fi

# ============================================
# 4. 安装 Rust
# ============================================
echo ""
echo ">>> 安装 Rust..."

if command -v rustc &> /dev/null; then
    RUST_VERSION=$(rustc --version)
    print_warning "Rust 已安装: $RUST_VERSION"
else
    # 使用国内镜像加速 (可选)
    # export RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static
    # export RUSTUP_UPDATE_ROOT=https://mirrors.ustc.edu.cn/rust-static/rustup

    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source $HOME/.cargo/env
    print_status "Rust 安装完成: $(rustc --version)"
fi

# 确保 cargo 在 PATH 中
if [ -f "$HOME/.cargo/env" ]; then
    source $HOME/.cargo/env
fi

# ============================================
# 5. 创建项目目录
# ============================================
echo ""
echo ">>> 创建项目目录..."

PROJECT_DIR="/var/www/terminal"
if [ -d "$PROJECT_DIR" ]; then
    print_warning "项目目录已存在: $PROJECT_DIR"
else
    mkdir -p /var/www
    print_status "项目目录创建完成: $PROJECT_DIR"
fi

# ============================================
# 6. 生成环境变量
# ============================================
echo ""
echo ">>> 生成安全密钥..."

JWT_SECRET=$(openssl rand -base64 32)
API_KEY=$(openssl rand -hex 32)

echo ""
echo "=========================================="
echo "安装完成！"
echo "=========================================="
echo ""
echo "Node.js: $(node -v)"
echo "npm: $(npm -v)"
echo "Rust: $(rustc --version 2>/dev/null || echo '需要重新登录后生效')"
echo "PM2: $(pm2 -v)"
echo ""
echo "=========================================="
echo "下一步操作:"
echo "=========================================="
echo ""
echo "1. 克隆项目:"
echo "   cd /var/www"
echo "   git clone https://github.com/KIMQI001/terminal.git"
echo "   cd terminal"
echo ""
echo "2. 创建环境变量文件:"
echo "   cp .env.example .env.local"
echo "   vi .env.local"
echo ""
echo "3. 使用以下生成的密钥:"
echo "   JWT_SECRET=$JWT_SECRET"
echo "   API_ENCRYPTION_KEY=$API_KEY"
echo ""
echo "4. 构建项目:"
echo "   npm install"
echo "   npm run build"
echo "   cd kline-server && cargo build --release"
echo ""
echo "5. 启动服务:"
echo "   pm2 start npm --name terminal -- start"
echo "   pm2 start ./kline-server/target/release/kline-server --name kline"
echo "   pm2 save && pm2 startup"
echo ""
print_warning "如果 Rust 命令不可用，请重新登录或执行: source ~/.cargo/env"
