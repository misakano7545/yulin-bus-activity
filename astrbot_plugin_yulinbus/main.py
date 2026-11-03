"""AstrBot 插件：玉林公交实时查询。

群里问「玉林 G02 路有没有车」，直接回当前车辆位置。
只认玉林（掌上公交 450900），换城市要改 bus.py 的 CITY。
"""

import asyncio
import re

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star

try:
    from .bus import answer
except ImportError:  # 脱离 AstrBot 单跑调试时按顶层模块导入
    from bus import answer

LINE = re.compile(r"(?P<name>(?:北流|陆川)?[A-Za-z]{0,2}\d{1,3})\s*路")
INTENT = ("车", "到哪", "几站", "多久", "还有", "来了")


class YulinBusPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    @filter.regex(LINE.pattern)
    async def bus(self, event: AstrMessageEvent):
        """查玉林公交线路的实时车辆，例：玉林 G02 路有没有车"""
        msg = event.message_str
        m = LINE.search(msg)
        if not m or not any(k in msg for k in INTENT):
            return
        line = m.group("name") + "路"
        try:
            text = await asyncio.to_thread(answer, line)
        except Exception as e:
            logger.warning(f"玉林公交查询失败: {e}")
            text = "公交数据源暂时没响应，稍后再问一次"
        yield event.plain_result(text)
