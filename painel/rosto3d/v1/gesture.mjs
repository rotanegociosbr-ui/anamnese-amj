export class Gesture {
 constructor(){this.active=new Set();this.start=null;this.multi=false;}
 down(e){if(e.button!==0)return false;this.active.add(e.pointerId);if(this.active.size>1){this.multi=true;return false;}this.start={id:e.pointerId,x:e.clientX,y:e.clientY,max:0};return true;}
 move(e){if(this.start?.id===e.pointerId)this.start.max=Math.max(this.start.max,Math.hypot(e.clientX-this.start.x,e.clientY-this.start.y));}
 up(e){this.move(e);const tap=e.button===0&&!this.multi&&this.start?.id===e.pointerId&&this.start.max<=6;this.cancel(e);return tap;}
 cancel(e){this.active.delete(e.pointerId);if(this.start?.id===e.pointerId)this.start=null;if(!this.active.size)this.multi=false;}
 clear(){this.active.clear();this.start=null;this.multi=false;}
}
