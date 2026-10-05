package main

import (
	"encoding/json"
	"log"
	"os"
	"regexp"
)

var digitsOnly = regexp.MustCompile(`^\d+$`)

// ponytail: 6 行数据的静态表，不写算法。改表不用重新编译。
var plateMap = map[string]string{}

func loadPlateMap(path string) {
	b, err := os.ReadFile(path)
	if err != nil {
		log.Printf("车牌映射表未加载 (%v) —— 非纯数字 licence 会原样透出并记日志", err)
		return
	}
	if err := json.Unmarshal(b, &plateMap); err != nil {
		log.Fatalf("解析 %s 失败: %v", path, err)
	}
	log.Printf("车牌映射表已加载: %d 条", len(plateMap))
}

// fleetNo 把上游 licence 转成自编号。
// 纯数字 = 自编号；否则当车牌查表；表里没有就原样返回并记日志（用于补齐映射表）。
func fleetNo(licence string) (no string, confident bool) {
	if digitsOnly.MatchString(licence) {
		return licence, true
	}
	if n, ok := plateMap[licence]; ok {
		return n, true
	}
	log.Printf("未知车牌 %q —— 请补进 plate_map.json", licence)
	return licence, false
}
