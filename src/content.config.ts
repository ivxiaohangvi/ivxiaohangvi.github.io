import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/** 稳定心情键：App 侧可以换图标，moodKey 才是权威 */
const moodKeySchema = z.enum(['veryHappy', 'happy', 'neutral', 'sad', 'verySad']);

/**
 * blog 集合：长文章
 * frontmatter 由 zod schema 严格校验，字段写错会在构建时报错
 */
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

/**
 * diary 集合：日记（由 Daily You 导出经 scripts/import-daily-you.mjs 转入）
 * 每个文件 = 一篇日记，图片放 public/diary/（该目录已整体加入 .gitignore，不进仓库）
 */
const diary = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/diary' }),
  schema: z.object({
    date: z.coerce.date(),
    /** 可选标题：大多数日记只有日期，少数篇章可以有一个名字 */
    title: z.string().optional(),
    /** 是否从 Daily You 备份恢复了具体时刻（决定页面上是否显示 HH:mm） */
    timeKnown: z.boolean().default(false),
    /** Daily You 导出的心情 emoji（如 😊），原文捕获 */
    mood: z.string().optional(),
    /** 心情的稳定键；有它就以它为准，emoji 只作回落 */
    moodKey: moodKeySchema.optional(),
    /** 日记标签，可空 */
    tags: z.array(z.string()).default([]),
    /** 图片 URL 列表（/diary/…），显示在正文上方 */
    images: z.array(z.string()).default([]),
    /** 相片背面的话（详情页彩蛋）：键是 images 里的路径，写了才有得翻 */
    imageBacks: z.record(z.string()).default({}),
    /** 非图片附件（音频 / 视频 / 文件），由导入器写入 */
    attachments: z
      .array(
        z.object({
          name: z.string(),
          url: z.string(),
          kind: z.enum(['audio', 'video', 'file']).default('file'),
        }),
      )
      .default([]),
    /** 加密封存：正文、标题、图片均在 public/diary/sealed/ 的密文里，Markdown 只留公开元数据 */
    locked: z.boolean().default(false),
    /** 对应 public/diary/sealed/<sealedId>.json；locked 时必填 */
    sealedId: z.string().optional(),
    /** 是否有加密附图：列表页据此显示占位图（数量本身不公开） */
    hasEncryptedImages: z.boolean().default(false),
    /** 测试 / 演示内容：页面上会明确打上“示例”标记 */
    sample: z.boolean().default(false),
  }).superRefine((data, ctx) => {
    if (data.locked && !data.sealedId) {
      ctx.addIssue({ code: 'custom', message: 'locked 的日记必须写 sealedId' });
    }
    if (!data.locked && data.sealedId) {
      ctx.addIssue({ code: 'custom', message: 'sealedId 只在 locked 日记里出现' });
    }
  }),
});

/**
 * moments 集合：动态 / 碎碎念（短内容时间流）
 */
const moments = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/moments' }),
  schema: z.object({
    date: z.coerce.date(),
    mood: z.string().optional(),
    /** 心情的稳定键；有它就以它为准，emoji 只作回落 */
    moodKey: moodKeySchema.optional(),
    tags: z.array(z.string()).default([]),
    /** 图片路径（/moments/…），放 public/moments/；有图时在时间轴就近粘一张便笺 */
    images: z.array(z.string()).default([]),
    /** 测试 / 演示内容：页面上会明确打上"示例"标记 */
    sample: z.boolean().default(false),
  }),
});

/**
 * photos 集合：摄影作品（每张照片一个 .md，正文可写拍摄故事）
 */
const photos = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/photos' }),
  schema: z.object({
    title: z.string(),
    /** 图片路径（/photos/…），放 public/photos/ */
    image: z.string(),
    date: z.coerce.date(),
    location: z.string().optional(),
    camera: z.string().optional(),
    /** 相册分区：填相册的 id 或标题即可归卷；缺省按年份自动分卷 */
    roll: z.string().optional(),
  }),
});

/**
 * photoRolls 集合：相册本体。一卷 = 一个胶卷桶 + 一条底片。
 * 照片靠 photos.roll 匹配这里的 id 或 title；建一个空相册也会在页面上
 * 生成可拖拽的空卷，适合先占位、后装片。
 */
const photoRolls = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/photo-rolls' }),
  schema: z.object({
    title: z.string(),
    /** 卷序按这个日期排；空卷也靠它决定插在哪两卷之间 */
    date: z.coerce.date(),
  }),
});

/**
 * tools 集合：自己搓的小工具入口
 */
const tools = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/tools' }),
  schema: z.object({
    name: z.string(),
    url: z.string(),
    icon: z.string().default('🛠️'),
    description: z.string(),
    /** 数字越小越靠前 */
    order: z.number().default(99),
  }),
});

/**
 * friends 集合：友人页的名片
 * 一个文件 = 一张名片；description 是「我」写的一句话，不是对方的 tagline
 */
const friends = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/friends' }),
  schema: z.object({
    name: z.string(),
    url: z.string().url(),
    desc: z.string(),
    tags: z.array(z.string()).default([]),
    /** 认识 / 交换友链的时间，用于排序 */
    since: z.coerce.date(),
    group: z.enum(['常去', '认识的人']).default('认识的人'),
    /** 站点头像（可选），放 public/friends/，缺省用站名首字 */
    avatar: z.string().optional(),
    order: z.number().default(99),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog, diary, moments, photos, photoRolls, tools, friends };
