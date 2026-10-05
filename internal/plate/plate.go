// Package plate 维护「车牌号 → 自编号」的映射。
//
// 上游 licence 字段不是类型稳定的：老车返自编号（433），新车返车牌（桂K12685D）。
// 表在 plate_map.json，改表不用重新编译。
package plate

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"regexp"
)

var digitsOnly = regexp.MustCompile(`^\d+$`)

// Table 是只读映射表：Load 之后不再改动，可并发读。
type Table struct {
	m map[string]string
}

// Load 读映射表。文件不存在时返回空表 + 错误 —— 调用方决定是否致命。
func Load(path string) (*Table, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return &Table{m: map[string]string{}}, err
	}
	m := map[string]string{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", path, err)
	}
	return &Table{m: m}, nil
}

func (t *Table) Len() int { return len(t.m) }

// FleetNo 把上游 licence 归一成自编号。
// 纯数字 = 自编号；否则当车牌查表；表里没有就原样返回并记日志（用于补齐映射表）。
func (t *Table) FleetNo(licence string) (string, bool) {
	if digitsOnly.MatchString(licence) {
		return licence, true
	}
	if n, ok := t.m[licence]; ok {
		return n, true
	}
	log.Printf("未知车牌 %q —— 请补进 plate_map.json", licence)
	return licence, false
}
