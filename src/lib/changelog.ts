// 此文件由 scripts/convert-changelog.js 自动生成
// 请勿手动编辑

export interface ChangelogEntry {
  version: string;
  date: string;
  added: string[];
  changed: string[];
  fixed: string[];
}

export const changelog: ChangelogEntry[] = [
  {
    version: "3.4.2",
    date: "2025-10-21",
    added: [
    "添加数据迁移功能",
    "加入卡片右键长按选项卡"
    ],
    changed: [
    "调整选项卡收藏按钮显示逻辑",
    "微调UI及收藏按钮显示逻辑",
    "优化移动端卡片长按复制问题",
    "微调播放页面UI",
    "简化调整播放页面",
    "调整分组配置弹窗UI",
    "微调视频源配置UI"
    ],
    fixed: [
    "修复CF数据迁入问题",
    "修复本地存储搜索",
    "修复本地存储TVBox接口"
    ]
  },
  {
    version: "3.3.0",
    date: "2025-10-16",
    added: [
    "用户组分配视频源功能",
    "视频源配置支持批量操作",
    "添加加载动画"
    ],
    changed: [
    "非本地存储默认关闭TVBox",
    "简化明暗模式变化",
    "优化 docker 构建流程"
    ],
    fixed: [
    "非本地模式视频源配置初始化"
    ]
  },
  {
    version: "3.2.0",
    date: "2025-10-04",
    added: [
    "添加Docker镜像自动构建工作流",
    "搜索建议添加开关控制"
    ],
    changed: [
    "优化搜索设置UI布局",
    "调整搜索建议排序逻辑",
    "优化搜索参数设置逻辑",
    "调整并简化播放页面UI",
    "调整移动端播放页面UI",
    "微调站点配置UI",
    "微调TVBox配置UI"
    ],
    fixed: [
      // 无修复内容
    ]
  },
  {
    version: "3.1.0",
    date: "2025-10-02",
    added: [
      // 无新增内容
    ],
    changed: [
    "TVBox的设置改为在管理面板中，原位置显示状态及其链接",
    "修改桌面端导航栏布局为顶栏",
    "桌面搜索页改为顶栏搜索框"
    ],
    fixed: [
    "卡片显示详情链接跳转"
    ]
  },
  {
    version: "3.0.0",
    date: "2025-09-30",
    added: [
    "添加TVBox配置接口",
    "添加对Selene的兼容"
    ],
    changed: [
      // 无变更内容
    ],
    fixed: [
    "修复首页动漫接口引起的崩溃",
    "修复docker播放刷新崩溃问题"
    ]
  },
  {
    version: "2.9.1",
    date: "2025-09-19",
    added: [
      // 无新增内容
    ],
    changed: [
    "搜索栏左侧源配置获取采用缓存",
    "优化搜索结果的筛选组件UI",
    "搜索结果区分为包含与不包含搜索词的结果",
    "删除播放存储无用缓存的逻辑",
    "开放分类配置中的添加分类"
    ],
    fixed: [
    "缓存失效时播放加载源不一致",
    "修复d1数据库管理配置保存报错"
    ]
  },
  {
    version: "2.8.4",
    date: "2025-09-14",
    added: [
    "添加搜索结果的排序选择"
    ],
    changed: [
    "优化搜索逻辑"
    ],
    fixed: [
    "修复对OrionTV的兼容",
    "修复d1数据库继续观看无法收藏"
    ]
  },
  {
    version: "2.8.0",
    date: "2025-09-09",
    added: [
    "添加cf部署",
    "添加d1支持"
    ],
    changed: [
      // 无变更内容
    ],
    fixed: [
      // 无修复内容
    ]
  },
  {
    version: "2.7.6",
    date: "2025-09-04",
    added: [
      // 无新增内容
    ],
    changed: [
    "调整搜索超时时间可选范围，及默认值",
    "添加docker部署支持"
    ],
    fixed: [
    "修复播放中搜索超时时间不生效"
    ]
  },
  {
    version: "2.7.4",
    date: "2025-08-31",
    added: [
      // 无新增内容
    ],
    changed: [
    "可自定义搜索超时时间",
    "播放时的搜索播放源超时时间同上",
    "细化失败源原因的展示"
    ],
    fixed: [
    "修复播放搜索无结果也缓存在localstorage"
    ]
  },
  {
    version: "2.7.0",
    date: "2025-08-30",
    added: [
    "搜索添加对源的选择功能"
    ],
    changed: [
    "优化筛选",
    "简洁模式跳过豆瓣数据加载"
    ],
    fixed: [
      // 无修复内容
    ]
  },
  {
    version: "2.6.4",
    date: "2025-08-30",
    added: [
      // 无新增内容
    ],
    changed: [
    "优化搜索:调整超时时间(获取首页超时时间过长)"
    ],
    fixed: [
    "修复播放缓存key不唯一",
    "修复聚合结果不准确"
    ]
  },
  {
    version: "2.6.1",
    date: "2025-08-29",
    added: [
    "添加简洁模式"
    ],
    changed: [
      // 无变更内容
    ],
    fixed: [
      // 无修复内容
    ]
  },
  {
    version: "2.5.1",
    date: "2025-08-28",
    added: [
      // 无新增内容
    ],
    changed: [
    "优化收藏状态检测,减少数据库请求",
    "优化搜索筛选展示逻辑",
    "边缘点击不触发播放"
    ],
    fixed: [
    "修复动漫番剧详情页面跳转"
    ]
  },
  {
    version: "2.4.7",
    date: "2025-08-26",
    added: [
    "搜索结果添加筛选功能"
    ],
    changed: [
      // 无变更内容
    ],
    fixed: [
    "主页展示评分",
    "搜索结果展示年份"
    ]
  },
  {
    version: "2.4.0",
    date: "2025-08-25",
    added: [
      // 无新增内容
    ],
    changed: [
    "站点配置可直接修改",
    "进一步优化搜索速度"
    ],
    fixed: [
    "修复搜索结果只能打开同一个"
    ]
  },
  {
    version: "2.3.6",
    date: "2025-08-24",
    added: [
      // 无新增内容
    ],
    changed: [
    "优化播放优选换源"
    ],
    fixed: [
    "修复播放视频源缓存"
    ]
  },
  {
    version: "2.3.4",
    date: "2025-08-24",
    added: [
      // 无新增内容
    ],
    changed: [
      // 无变更内容
    ],
    fixed: [
    "修复管理功能不生效",
    "修复netlify无法部署",
    "修复非本地数据库初始化"
    ]
  },
  {
    version: "2.3.1",
    date: "2025-08-23",
    added: [
      // 无新增内容
    ],
    changed: [
      // 无变更内容
    ],
    fixed: [
    "修复配置文件不生效",
    "修复无config.json文件报错",
    "修复失败源不准确"
    ]
  },
  {
    version: "2.2.8",
    date: "2025-08-22",
    added: [
      // 无新增内容
    ],
    changed: [
    "转移视频源优选按钮至播放页面"
    ],
    fixed: [
    "优化播放换源",
    "优化失败源显示逻辑",
    "修复搜索路由问题"
    ]
  },
  {
    version: "2.2.1",
    date: "2025-08-22",
    added: [
    "搜索结果展示失败源"
    ],
    changed: [
    "移除无效代理Cors Anywhere"
    ],
    fixed: [
    "修复一次搜索两个请求的问题"
    ]
  },
  {
    version: "2.1.0",
    date: "2025-08-21",
    added: [
    "支持流式搜索搜索模式",
    "搜索结果展示视频源"
    ],
    changed: [
    "重新支持localstorage",
    "独立缓存播放源"
    ],
    fixed: [
    "修复视频播放缓存逻辑问题"
    ]
  },
  {
    version: "2.0.1",
    date: "2025-08-13",
    added: [
      // 无新增内容
    ],
    changed: [
    "版本检查和变更日志请求 Github"
    ],
    fixed: [
    "微调管理面板样式"
    ]
  },
  {
    version: "2.0.0",
    date: "2025-08-13",
    added: [
    "支持配置文件在线配置和编辑",
    "搜索页搜索框实时联想",
    "去除对 localstorage 模式的支持"
    ],
    changed: [
    "播放记录删除按钮改为垃圾桶图标以消除歧义"
    ],
    fixed: [
    "限制设置面板的最大长度，防止超出视口"
    ]
  },
  {
    version: "1.1.1",
    date: "2025-08-12",
    added: [
      // 无新增内容
    ],
    changed: [
    "修正 zwei 提供的 cors proxy 地址",
    "移除废弃代码"
    ],
    fixed: [
    "[运维] docker workflow release 日期使用东八区日期"
    ]
  },
  {
    version: "1.1.0",
    date: "2025-08-12",
    added: [
    "每日新番放送功能，展示每日新番放送的番剧"
    ],
    changed: [
      // 无变更内容
    ],
    fixed: [
    "修复远程 CHANGELOG 无法提取变更内容的问题"
    ]
  },
  {
    version: "1.0.5",
    date: "2025-08-12",
    added: [
      // 无新增内容
    ],
    changed: [
    "实现基于 Git 标签的自动 Release 工作流"
    ],
    fixed: [
      // 无修复内容
    ]
  },
  {
    version: "1.0.4",
    date: "2025-08-11",
    added: [
    "优化版本管理工作流，实现单点修改"
    ],
    changed: [
    "版本号现在从 CHANGELOG 自动提取，无需手动维护 VERSION.txt"
    ],
    fixed: [
      // 无修复内容
    ]
  },
  {
    version: "1.0.3",
    date: "2025-08-11",
    added: [
      // 无新增内容
    ],
    changed: [
    "升级播放器 Artplayer 至版本 5.2.5"
    ],
    fixed: [
      // 无修复内容
    ]
  },
  {
    version: "1.0.2",
    date: "2025-08-11",
    added: [
      // 无新增内容
    ],
    changed: [
    "版本号比较机制恢复为数字比较，仅当最新版本大于本地版本时才认为有更新",
    "[运维] 自动替换 version.ts 中的版本号为 VERSION.txt 中的版本号"
    ],
    fixed: [
      // 无修复内容
    ]
  },
  {
    version: "1.0.1",
    date: "2025-08-11",
    added: [
      // 无新增内容
    ],
    changed: [
      // 无变更内容
    ],
    fixed: [
    "修复版本检查功能，只要与最新版本号不一致即认为有更新"
    ]
  },
  {
    version: "1.0.0",
    date: "2025-08-10",
    added: [
    "基于 Semantic Versioning 的版本号机制",
    "版本信息面板，展示本地变更日志和远程更新日志"
    ],
    changed: [
      // 无变更内容
    ],
    fixed: [
      // 无修复内容
    ]
  }
];

export default changelog;
