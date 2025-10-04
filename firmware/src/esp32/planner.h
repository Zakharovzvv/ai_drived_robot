#pragma once
#include <Arduino.h>
#include <vector>
#include <queue>

// Minimal A* over grid indices (predefined in main)
struct Node { int x,y; int g,h; int f; int px,py; };

struct Grid {
  int W,H; // width/height (nodes)
  bool passable(int x,int y) const { return x>=0&&y>=0&&x<W&&y<H; }
};

inline int hManh(int x1,int y1,int x2,int y2){ return abs(x1-x2)+abs(y1-y2); }

inline bool astar(const Grid& g, Node start, Node goal, std::vector<Node>& out){
  auto key=[&](int x,int y){ return y*g.W + x; };
  std::vector<int> came(g.W*g.H, -1);
  std::vector<int> gScore(g.W*g.H, INT_MAX);
  struct QN{int f,x,y;};
  struct Cmp{ bool operator()(const QN&a,const QN&b)const{return a.f>b.f;}};
  std::priority_queue<QN, std::vector<QN>, Cmp> pq;
  int s=key(start.x,start.y), t=key(goal.x,goal.y);
  gScore[s]=0; pq.push({hManh(start.x,start.y,goal.x,goal.y), start.x,start.y});
  const int dx[4]={1,-1,0,0}; const int dy[4]={0,0,1,-1};
  while(!pq.empty()){
    auto q=pq.top(); pq.pop(); int k=key(q.x,q.y);
    if(k==t){ // reconstruct
      out.clear(); int cx=q.x, cy=q.y; while(!(cx==start.x && cy==start.y)){
        int pk=came[key(cx,cy)]; int px=pk%g.W, py=pk/g.W; out.push_back({cx,cy,0,0,0,px,py}); cx=px; cy=py;
      } out.push_back({start.x,start.y}); std::reverse(out.begin(), out.end()); return true; }
    for(int i=0;i<4;i++){
      int nx=q.x+dx[i], ny=q.y+dy[i]; if(!g.passable(nx,ny)) continue;
      int nk=key(nx,ny); int ng=gScore[k]+1; if(ng<gScore[nk]){ gScore[nk]=ng; came[nk]=k; int f=ng + hManh(nx,ny,goal.x,goal.y); pq.push({f,nx,ny}); }
    }
  }
  return false;
}
