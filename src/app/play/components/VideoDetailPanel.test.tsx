/**
 * `VideoDetailPanel`（Hero 区）冒烟测试。
 *
 * 这个组件是全新重写的，且有两条**必须锁死**的行为：
 * 1. **操作按钮不能在 `<h1>` 里** —— 旧实现把 `<div>`/`<button>` 塞进 `h1`，
 *    那不是 phrasing content，属于非法 HTML，浏览器会自行纠正 DOM。
 * 2. **背景层的 768px 闸门** —— 手机端不能渲染背景层，否则会白下载一张大图。
 *
 * 另外覆盖简介的「展开/收起」：旧实现用 `overflow-y-auto` 但祖先链没有确定高度，
 * 滚动实际是失效的（长简介会把整页撑长），所以改成限行必须验证真的切了 class。
 */

import { fireEvent, render } from '@testing-library/react';

import { VideoDetailPanel } from './VideoDetailPanel';

const POSTER = 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg';

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
}

type Props = Parameters<typeof VideoDetailPanel>[0];

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    videoTitle: '进击的巨人',
    videoYear: '2013',
    totalEpisodes: 25,
    currentEpisodeIndex: 0,
    detail: {
      title: '进击的巨人',
      year: '2013',
      poster: '',
      desc: '短简介',
      class: '动画',
      source_name: '暴风',
      type_name: 'TV',
      episodes: [],
      episodes_titles: ['第1集'],
    } as unknown as Props['detail'],
    favorited: false,
    following: false,
    onToggleFavorite: jest.fn(),
    onToggleFollowing: jest.fn(),
    videoUrl: 'https://example.com/a.m3u8',
    // 0 表示不渲染豆瓣外链；currentSource/currentId 留空则不渲染追更按钮 ——
    // 让这个冒烟测试只盯 Hero 自身，不耦合同级组件的内部实现
    videoDoubanId: 0,
    currentSource: '',
    currentId: '',
    onDownload: jest.fn(),
    ...overrides,
  };
}

/** 取背景层（带 aria-hidden 的那一层） */
function queryBackdrop(container: HTMLElement) {
  return container.querySelector('[aria-hidden="true"]');
}

/**
 * 取一个**必须存在**的元素。
 *
 * 不用 `querySelector(...)!`：非空断言在断言失败时只给一个没信息量的
 * "cannot read properties of null"，而这里抛出的消息直接指出选择器。
 * 顺带也满足项目 lint（禁止 non-null assertion）。
 */
function mustQuery(container: HTMLElement, selector: string): Element {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`预期存在的元素没找到: ${selector}`);
  return el;
}

afterEach(() => {
  setViewportWidth(1024);
});

describe('VideoDetailPanel 结构与合规', () => {
  it('渲染标题与集数标签', () => {
    const { getByText } = render(<VideoDetailPanel {...makeProps()} />);
    expect(getByText('进击的巨人')).toBeInTheDocument();
    expect(getByText('第1集')).toBeInTheDocument();
  });

  it('🔒 <h1> 内不含任何 button（修掉旧的非法 HTML）', () => {
    const { container } = render(<VideoDetailPanel {...makeProps()} />);
    const h1 = mustQuery(container, 'h1');
    expect(h1.querySelectorAll('button')).toHaveLength(0);
    // 也不该有 div —— h1 只允许 phrasing content
    expect(h1.querySelectorAll('div')).toHaveLength(0);
  });

  it('单集剧集不显示集数标签', () => {
    const { container, queryByText } = render(
      <VideoDetailPanel {...makeProps({ totalEpisodes: 1 })} />
    );
    expect(container.querySelector('h1')).not.toBeNull();
    expect(queryByText(/第 \d+ 集/)).toBeNull();
  });

  it('标题为空时给出兜底文案（不渲染空白标题）', () => {
    const { getByText } = render(
      <VideoDetailPanel {...makeProps({ videoTitle: '' })} />
    );
    expect(getByText('影片标题')).toBeInTheDocument();
  });
});

describe('VideoDetailPanel 背景层闸门（决策 C）', () => {
  it('无海报时不渲染背景层，也不渲染前景图', () => {
    setViewportWidth(1440);
    const { container } = render(<VideoDetailPanel {...makeProps()} />);
    expect(queryBackdrop(container)).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('宽屏 + 有海报 → 前景图与背景层都渲染', () => {
    setViewportWidth(1440);
    const { container } = render(
      <VideoDetailPanel {...makeProps({ videoCover: POSTER })} />
    );
    expect(container.querySelector('img')).not.toBeNull();
    expect(queryBackdrop(container)).not.toBeNull();
  });

  it('🔒 窄屏（手机）+ 有海报 → 只有前景图，**不渲染背景层**（不打大图）', () => {
    setViewportWidth(390);
    const { container } = render(
      <VideoDetailPanel {...makeProps({ videoCover: POSTER })} />
    );
    // 前景小图保留（决策 C：缩为标题左侧小图）
    expect(container.querySelector('img')).not.toBeNull();
    // 背景层必须缺席
    expect(queryBackdrop(container)).toBeNull();
  });

  it('恰好在 768px 断点上渲染背景层', () => {
    setViewportWidth(768);
    const { container } = render(
      <VideoDetailPanel {...makeProps({ videoCover: POSTER })} />
    );
    expect(queryBackdrop(container)).not.toBeNull();
  });

  it('SSR（宽度 0）不渲染背景层，避免首帧发起请求', () => {
    setViewportWidth(0);
    const { container } = render(
      <VideoDetailPanel {...makeProps({ videoCover: POSTER })} />
    );
    expect(queryBackdrop(container)).toBeNull();
  });

  it('没传 videoCover 时退回 detail.poster', () => {
    setViewportWidth(1440);
    const props = makeProps();
    (props.detail as { poster?: string }).poster = POSTER;
    const { container } = render(<VideoDetailPanel {...props} />);
    expect(container.querySelector('img')).not.toBeNull();
  });
});

describe('VideoDetailPanel 海报位置', () => {
  it('🔒 海报固定在文字左侧：DOM 里是第一个孩子，且不用 order-* 位移', () => {
    setViewportWidth(1440);
    const { container } = render(
      <VideoDetailPanel {...makeProps({ videoCover: POSTER })} />
    );

    const img = mustQuery(container, 'img');
    const row = img.parentElement;
    expect(row).not.toBeNull();

    // flex-row 下 DOM 顺序即视觉顺序 → 海报必须是第一个孩子才在最左
    const children = Array.from(row ? row.children : []);
    expect(children[0]?.tagName).toBe('IMG');

    // 不许再用 order-* 把它在宽屏挪到右侧（用户明确要求放左侧）
    expect(img.className).not.toMatch(/\border-/);
  });
});

describe('VideoDetailPanel 简介展开（决策 D1）', () => {
  const LONG = '字'.repeat(300);

  it('短简介不出现「展开」', () => {
    const { queryByText } = render(
      <VideoDetailPanel {...makeProps()} />
    );
    expect(queryByText('展开')).toBeNull();
    expect(queryByText('收起')).toBeNull();
  });

  it('长简介默认限行，点「展开」后取消限行', () => {
    const props = makeProps();
    (props.detail as { desc?: string }).desc = LONG;
    const { getByText, container } = render(<VideoDetailPanel {...props} />);

    const p = mustQuery(container, 'p');
    expect(p.className).toContain('line-clamp-3');
    expect(p.textContent).toBe(LONG);

    fireEvent.click(getByText('展开'));

    const after = mustQuery(container, 'p');
    expect(after.className).not.toContain('line-clamp-3');
    expect(getByText('收起')).toBeInTheDocument();
  });

  it('展开后能再收起', () => {
    const props = makeProps();
    (props.detail as { desc?: string }).desc = LONG;
    const { getByText, container } = render(<VideoDetailPanel {...props} />);

    fireEvent.click(getByText('展开'));
    fireEvent.click(getByText('收起'));
    expect(mustQuery(container, 'p').className).toContain('line-clamp-3');
  });

  it('无简介时不渲染简介块', () => {
    const props = makeProps();
    (props.detail as { desc?: string }).desc = '';
    const { container } = render(<VideoDetailPanel {...props} />);
    expect(container.querySelector('p')).toBeNull();
  });
});

describe('VideoDetailPanel 操作按钮', () => {
  it('收藏按钮点击触发回调', () => {
    const onToggleFavorite = jest.fn();
    const { container } = render(
      <VideoDetailPanel {...makeProps({ onToggleFavorite })} />
    );
    const favBtn = container.querySelector(
      'button[aria-label="加入收藏"]'
    ) as HTMLButtonElement;
    expect(favBtn).not.toBeNull();
    fireEvent.click(favBtn);
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
  });

  it('已有 videoUrl 时渲染下载按钮', () => {
    const { container } = render(<VideoDetailPanel {...makeProps()} />);
    expect(
      container.querySelector('button[aria-label="下载视频"]')
    ).not.toBeNull();
  });

  it('无 videoUrl 时不渲染下载按钮', () => {
    const { container } = render(
      <VideoDetailPanel {...makeProps({ videoUrl: '' })} />
    );
    expect(container.querySelector('button[aria-label="下载视频"]')).toBeNull();
  });
});
