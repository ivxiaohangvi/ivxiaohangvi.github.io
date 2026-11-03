---
title: 记一次群晖 DS216SE NAS 固件升级过程中意外断电导致的死亡蓝灯闪烁
description: DS216SE 升级固件途中断电，之后只剩蓝灯一直闪。凑一根 CH340G 从串口进 uboot，用 U 盘把 rd.bin 载进内存、再 bootm 引导内核，机器就回来了。
pubDate: 2025-07-12
tags:
  - 群晖
  - NAS
  - 救砖
---

给 DS216SE 升级固件，进度条走到一半，电断了。再开机，前面板只剩一颗蓝灯慢慢闪，网口没有反应，DSM 也进不去——群晖玩家口中那个熟悉的「死亡蓝灯」。

这类故障听起来吓人，其实比想象中好救：固件升级刷坏的多半是系统分区，而机器最底层的那段引导程序 uboot 通常还完好。这台 DS216SE 的 Flash 只有 8 MB，uboot、内核 zImage 和初始 Ramdisk（rd.bin）就按固定偏移量躺在这 8 MB 里。只要能通过串口进到 uboot 的命令行，剩下的事就是把它本来就有的东西重新引导一次。

下面是我当时的完整过程。

## 用到的工具

- CH340G USB 转 TTL 模块（其他的型号也行，能出串口就可以）
- 一个 U 盘（只测试过 FAT32 格式）

![CH340G USB 转 TTL 模块](/blog/ds216se-unbrick/01.webp)

## 先确认 Flash 里有什么

用编程器读出的固件里，三个关键文件的起始偏移是固定的：

| 文件     | 偏移量          | 作用                        |
| ------ | ------------ | ------------------------- |
| uboot  | `0x00000000` | 最底层的引导程序，串口命令行就在它里面       |
| zImage | `0x000C0000` | Linux 内核                  |
| rd.bin | `0x00390000` | 初始 Ramdisk，挂载后才会去找真正的系统分区 |

下面三张图是同一份固件在十六进制编辑器里的样子，主要看右侧 ASCII 栏，能直接认出这几段数据。

uboot 开头是 `Z N E e` 这几个字节：

![uboot 在 00000000 处的数据](/blog/ds216se-unbrick/02.webp)

zImage 从 `000C0000` 开始，ASCII 里是 `Linux-3.2.101`：

![zImage 在 000C0000 处](/blog/ds216se-unbrick/03.webp)

rd.bin 从 `00390000` 开始，ASCII 里是 `synology_armada370_216se 42218`：

![rd.bin 在 00390000 处](/blog/ds216se-unbrick/04.webp)

## 接线

TTL 只接三根线：RXD、TXD、GND。接反了收不到字符，把 RX 和 TX 对调再试一次即可。

![DS216SE 主板，TTL 针脚在这一侧](/blog/ds216se-unbrick/05.webp)

## 准备 U 盘

从群晖官网下载对应型号的固件包，解压出里面的 `rd.bin` 和 `zImage`，一起拷进 U 盘根目录，插到 NAS 上。

## 在 uboot 里手动引导

串口终端里敲一下回车，能看到 `Marvell>>` 提示符，就说明 uboot 还活着。接着依次执行：

```text
usb start
# 扫描 usb 设备

fatload usb 0:1 0x08000000 rd.bin
# 从 usb 中载入 rd.bin 到内存

iminfo 0x08000000
# 校验

bootm 0xf40c0000 0x08000000
# 启动内核和 Ramdisk
```

`usb start` 识别到 U 盘之后，`fatload` 把 rd.bin 读到内存的 `0x08000000`，`iminfo` 确认这是一份合法的镜像，最后 `bootm` 让内核带着这块 Ramdisk 跑起来。

这里有个容易卡住的地方：`bootm` 的第一个参数 `0xf40c0000` 是 zImage 在内存中的地址。我这次是用编程器提前把 zImage 烧回固件里了，所以没有单独载入内核；如果固件里没有可用的 zImage，就得先用 `fatload usb 0:1 0xf40c0000 zImage`（换成 `0x2000000` 也可以）自己载入一份，再执行 `bootm`。

## 启动日志

回车之后串口开始刷日志，能看到内核和 Ramdisk 依次被校验、载入：

```text
## Booting kernel from Legacy Image at f40c0000 ...
   Image Name:   Linux-3.2.101
   Created:      2023-01-16  9:53:46 UTC
   Image Type:   ARM Linux Kernel Image (uncompressed)
   Data Size:    1894160 Bytes = 1.8 MiB
   Load Address: 00008000
   Entry Point:  00008000
   Verifying Checksum ... OK
## Loading init Ramdisk from Legacy Image at f4390000 ...
   Image Name:   synology_armada370_216se 42218
   Created:      2023-01-17  2:10:27 UTC
   Image Type:   ARM Linux RAMDisk Image (gzip compressed)
   Data Size:    3540927 Bytes = 3.4 MiB
   Load Address: 08000000
   Entry Point:  08000000
   Verifying Checksum ... OK
   Loading Kernel Image ... OK
OK
```

最后那个 `OK` 出来，内核已经接手了，接下来串口会继续打印一堆内核启动信息，机器便能重新进入 DSM。

## 几个说明

- 这套办法能成立的前提是 **uboot 没被刷坏**。如果 uboot 都丢了，串口不会给你 `Marvell>>`，那就只能上编程器直接写 Flash 了。
- RXD、TXD 是交叉关系，接收端要接对端的发送端。看到乱码或者完全没输出，先检查这两根线。
- 引导进系统之后建议重新完整升级一次固件，把被断电打断的那次写坏的分区补回来，否则重启可能又回到蓝灯。

## 参考

- [Synology DS216se wrong ramdisk image format](https://www.synoforum.com/threads/synology-ds216se-wrong-ramdisk-image-format.11665/)
- [forum.doozan.com — read.php?3,104929](https://forum.doozan.com/read.php?3,104929)
- [forum.doozan.com — read.php?3,99414](https://forum.doozan.com/read.php?3,99414)
- [forum.doozan.com — read.php?3,42599](https://forum.doozan.com/read.php?3,42599)
- [forum.doozan.com — read.php?3,100059](https://forum.doozan.com/read.php?3,100059)
- [forum.doozan.com — read.php?2,23630](https://forum.doozan.com/read.php?2,23630)
- [YouTube 上的救砖演示](https://www.youtube.com/watch?v=UELYOvFPeLs)

---

> 本文最初发布于哔哩哔哩：[记一次群晖DS216SE NAS 固件升级过程中意外断电导致的死亡蓝灯闪烁](https://www.bilibili.com/opus/1088623597947191302)
